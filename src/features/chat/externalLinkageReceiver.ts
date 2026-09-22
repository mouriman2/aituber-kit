import { logger } from '@/lib/logger'
import { EmotionType, Message } from '@/features/messages/messages'
import { speakCharacter } from '@/features/messages/speakCharacter'
import homeStore from '@/features/stores/home'
import settingsStore from '@/features/stores/settings'
import externalLinkageWebSocketStore from '@/features/stores/externalLinkageWebSocketStore'
import { generateMessageId } from '@/utils/messageUtils'
import { createExternalLinkageLifecycleEvent } from '@/features/externalLinkage/externalLinkageProtocol'
import { extractMotionTag } from '@/features/chat/speechPipeline/tagExtractors'

type ExternalSpeechLifecycleState = {
  pendingSpeechCount: number
  speechSegmentCount: number
  responseEnded: boolean
  responseDoneSent: boolean
}

/**
 * 外部連携v2の発話ライフサイクル状態（requestId単位）。
 * モジュールスコープのMapを直接持たずファクトリーで包むことで、
 * テストからのリセットを可能にする（挙動は従来と同一）。
 */
export const createExternalSpeechLifecycle = () => {
  const states = new Map<string, ExternalSpeechLifecycleState>()

  const get = (requestId: string): ExternalSpeechLifecycleState => {
    const existing = states.get(requestId)
    if (existing) return existing

    const state: ExternalSpeechLifecycleState = {
      pendingSpeechCount: 0,
      speechSegmentCount: 0,
      responseEnded: false,
      responseDoneSent: false,
    }
    states.set(requestId, state)
    return state
  }

  return {
    get,
    delete: (requestId: string) => states.delete(requestId),
    reset: () => states.clear(),
  }
}

const lifecycle = createExternalSpeechLifecycle()

const sendExternalLinkageLifecycleEvent = (
  type: string,
  requestId?: string | null,
  payload: Record<string, unknown> = {}
) => {
  if (!requestId) return

  const state = externalLinkageWebSocketStore.getState()
  if (state.protocolVersion !== '2') return

  state.send(
    JSON.stringify(
      createExternalLinkageLifecycleEvent(type, requestId, payload)
    )
  )
}

const maybeSendExternalResponseDone = (requestId?: string | null) => {
  if (!requestId) return

  const state = lifecycle.get(requestId)
  if (
    !state.responseEnded ||
    state.pendingSpeechCount > 0 ||
    state.responseDoneSent
  ) {
    return
  }

  state.responseDoneSent = true
  sendExternalLinkageLifecycleEvent('character.response.done', requestId, {
    speechSegmentCount: state.speechSegmentCount,
    completedAt: new Date().toISOString(),
  })
  lifecycle.delete(requestId)
}

/**
 * WebSocket（外部連携モード）からのテキストを受信したときの処理
 */
export const handleReceiveTextFromWsFn =
  () =>
  async (
    text: string,
    role?: string,
    emotion: EmotionType = 'neutral',
    type?: string,
    image?: string,
    requestId?: string
  ) => {
    const sessionId = generateMessageId()
    if (text === null || role === undefined) return

    // 外部サーバからのテキスト先頭の [motion:xxx] をポーズ指定として取り出す（内蔵AI経路と同じ書式）
    const { motionTag, remainingText } = extractMotionTag(text)
    const motion = motionTag || undefined
    text = remainingText

    const ss = settingsStore.getState()
    const hs = homeStore.getState()
    const wsManager = externalLinkageWebSocketStore.getState().wsManager

    if (ss.externalLinkageMode) {
      logger.log('ExternalLinkage Mode: true')
    } else {
      logger.log('ExternalLinkage Mode: false')
      return
    }

    homeStore.setState({ chatProcessing: true })
    sendExternalLinkageLifecycleEvent('character.message.received', requestId, {
      text,
      role,
      emotion,
      messageType: type ?? '',
      hasImage: Boolean(image),
      receivedAt: new Date().toISOString(),
    })

    if (role !== 'user') {
      if (type === 'start') {
        // startの場合は何もしない（textは空文字のため）
        logger.log('Starting new response')
        wsManager?.setTextBlockStarted(false)
      } else if (
        hs.chatLog.length > 0 &&
        hs.chatLog[hs.chatLog.length - 1].role === role &&
        wsManager?.textBlockStarted
      ) {
        // 既存のメッセージに追加（IDを維持）
        const lastMessage = hs.chatLog[hs.chatLog.length - 1]
        const lastContent =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : Array.isArray(lastMessage.content)
              ? lastMessage.content[0].text
              : ''

        const appendedText = lastContent + text
        const appendedContent: Message['content'] = Array.isArray(
          lastMessage.content
        )
          ? [
              { type: 'text' as const, text: appendedText },
              lastMessage.content[1],
            ]
          : appendedText

        homeStore.getState().upsertMessage({
          id: lastMessage.id,
          role: role,
          content: appendedContent,
        })
        sendExternalLinkageLifecycleEvent(
          'character.message.rendered',
          requestId,
          {
            text,
            role,
            emotion,
            messageType: type ?? '',
            hasImage: Boolean(image),
            renderedAt: new Date().toISOString(),
          }
        )
      } else {
        // 新しいメッセージを追加（新規IDを生成）
        const messageContent: Message['content'] = image
          ? [
              { type: 'text' as const, text: text },
              { type: 'image' as const, image: image },
            ]
          : text

        homeStore.getState().upsertMessage({
          role: role,
          content: messageContent,
        })
        sendExternalLinkageLifecycleEvent(
          'character.message.rendered',
          requestId,
          {
            text,
            role,
            emotion,
            messageType: type ?? '',
            hasImage: Boolean(image),
            renderedAt: new Date().toISOString(),
          }
        )
        wsManager?.setTextBlockStarted(true)
      }

      if (role === 'assistant' && text !== '') {
        const speechSegmentId = generateMessageId()
        if (requestId) {
          const lifecycleState = lifecycle.get(requestId)
          lifecycleState.pendingSpeechCount += 1
          lifecycleState.speechSegmentCount += 1
        }
        try {
          // 文ごとに音声を生成 & 再生、返答を表示
          speakCharacter(
            sessionId,
            {
              message: text,
              emotion: emotion,
              motion,
            },
            () => {
              // assistantMessage is now derived from chatLog, no need to set it separately
              sendExternalLinkageLifecycleEvent(
                'character.speech.start',
                requestId,
                {
                  speechSegmentId,
                  text,
                  emotion,
                  startedAt: new Date().toISOString(),
                }
              )
            },
            () => {
              // hs.decrementChatProcessingCount()
              if (requestId) {
                const lifecycleState = lifecycle.get(requestId)
                lifecycleState.pendingSpeechCount = Math.max(
                  0,
                  lifecycleState.pendingSpeechCount - 1
                )
              }
              sendExternalLinkageLifecycleEvent(
                'character.speech.done',
                requestId,
                {
                  speechSegmentId,
                  text,
                  emotion,
                  completedAt: new Date().toISOString(),
                }
              )
              maybeSendExternalResponseDone(requestId)
            }
          )
        } catch (e) {
          logger.error('Error in speakCharacter:', e)
          if (requestId) {
            const lifecycleState = lifecycle.get(requestId)
            lifecycleState.pendingSpeechCount = Math.max(
              0,
              lifecycleState.pendingSpeechCount - 1
            )
          }
          sendExternalLinkageLifecycleEvent(
            'character.speech.error',
            requestId,
            {
              speechSegmentId,
              text,
              emotion,
              message: e instanceof Error ? e.message : String(e),
              failedAt: new Date().toISOString(),
            }
          )
          maybeSendExternalResponseDone(requestId)
        }
      }

      if (type === 'end') {
        // レスポンスの終了処理
        logger.log('Response ended')
        wsManager?.setTextBlockStarted(false)
        homeStore.setState({ chatProcessing: false })
        if (requestId) {
          lifecycle.get(requestId).responseEnded = true
          maybeSendExternalResponseDone(requestId)
        }
      }
    }

    homeStore.setState({ chatProcessing: type !== 'end' })
  }
