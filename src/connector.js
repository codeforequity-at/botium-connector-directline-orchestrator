const url = require('url')

const uuidv4 = require('uuid').v4
const WebSocket = require('ws')
const _ = require('lodash')
const HttpsProxyAgent = require('https-proxy-agent')
const debug = require('debug')('botium-connector-directline-orchestrator')
const Queue = require('better-queue')

const DirectlineConnector = require('botium-connector-directline3').PluginClass

const Capabilities = require('./Capabilities')

const Defaults = {
  // TODO move defaults to UI
  // [Capabilities.DIRECTLINE_ORCHESTRATOR_TOKEN_URL]: 'xxx',
  // [Capabilities.DIRECTLINE_ORCHESTRATOR_CONVERSATIONS_URL]: 'xxx',
  [Capabilities.DIRECTLINE_ORCHESTRATOR_HANDLE_ACTIVITY_TYPES]: 'message'
}

const DelegateCaps = [
  [Capabilities.DIRECTLINE_ORCHESTRATOR_DIRECTLINE3_ACTIVITY_TEMPLATE],
  [Capabilities.DIRECTLINE_ORCHESTRATOR_DIRECTLINE3_BUTTON_TYPE],
  [Capabilities.DIRECTLINE_ORCHESTRATOR_DIRECTLINE3_BUTTON_VALUE_FIELD],
  [Capabilities.DIRECTLINE_ORCHESTRATOR_DIRECTLINE3_ACTIVITY_VALIDATION]
]

// it is not possible to use directline connector, because custom header values in rest calls
// many code parts are coming from websocket, and directline connectors
class BotiumConnectorDirectlineOrchestrator {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
    this.token = null
    this.conversationId = null
    this.receivedMessageIds = null
    this.ws = null
    this.wsOpened = false
    // The rest request to send message returns AFTER a chat response is coming via webhook.
    // So to keep the user message BEFORE the bot response visually, we need to use a semaphore
    this.messageSendingSemaphorePromise = null
    this.messageSendingSemaphorePromiseResolve = null
  }

  async Validate () {
    // TODO
    debug('Validate called')
    this.caps = Object.assign({}, Defaults, _.pickBy(this.caps, (value, key) => !Object.prototype.hasOwnProperty.call(Defaults, key) || !_.isString(value) || value !== ''))
  }

  async Build () {
    debug('Build called')
    const directlineCaps = {}
    for (const c of DelegateCaps) {
      if (!_.isNil(this.caps[c[0]])) {
        directlineCaps[c[0].replace('DIRECTLINE_ORCHESTRATOR_DIRECTLINE3', 'DIRECTLINE3')] = this.caps[c[0]]
      }
    }
    this.delegateConnectorForConverting = new DirectlineConnector({ caps: this.caps })
  }

  async Start () {
    debug('Start called')
    this.receivedMessageIds = {}
    this.queue = new Queue((input, cb) => {
      input().then(result => cb(null, result)).catch(err => cb(err))
    })

    if (this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_GENERATE_USERNAME]) {
      this.me = uuidv4()
    } else {
      this.me = (this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_DIRECTLINE3_ACTIVITY_TEMPLATE] && _.get(this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_DIRECTLINE3_ACTIVITY_TEMPLATE], 'from.id')) || 'me'
    }

    debug('Token generate')
    try {
      const responseToken = await fetch(this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_TOKEN_URL], {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_USER_AGENT],
          cookie: `CID=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_CID]}; auth=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_AUTH]}; xptwj=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_XPTWJ]}; _px3=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR__PX3]}`
        }
      })
      if (!responseToken.ok) {
        let tokenData
        try {
          tokenData = await responseToken.json()
        } catch (err) {
        }
        throw new Error(`Token generation failed with status: ${responseToken.status} ${responseToken.statusText} ${tokenData && JSON.stringify(tokenData)}`)
      }
      const tokenData = await responseToken.json()
      this.token = tokenData.token
      this.conversationId = tokenData.conversationId
      // TODO handle token expiration and refresh if needed
      debug(`Token generate token: ${this.token}, conversationId: ${this.conversationId}, full response: ${JSON.stringify(tokenData, null, 2)}`)
    } catch (err) {
      debug(`Error generating token: ${err.message}`)
      throw new Error(`Failed to generate token: ${err.message}`)
    }

    debug('Conversation initiate')
    let websocketUrl
    try {
      const responseInitConversation = await fetch(this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_CONVERSATIONS_URL], {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + this.token,
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_USER_AGENT],
          cookie: `CID=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_CID]}; auth=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_AUTH]}; xptwj=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_XPTWJ]}; _px3=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR__PX3]}`
        }
      })
      if (!responseInitConversation.ok) {
        throw new Error(`Conversation initiation failed with status: ${responseInitConversation.status} ${responseInitConversation.statusText}`)
      }
      const conversationData = await responseInitConversation.json()
      websocketUrl = conversationData.streamUrl || conversationData.url // Adapting to potential property name differences
      debug(`Conversation initiated, websocket URL: ${websocketUrl} full response: ${JSON.stringify(conversationData, null, 2)}`)
    } catch (err) {
      debug(`Error initiating conversation or setting up WebSocket: ${err.message}`)
      throw new Error(`Failed to initiate conversation or setup WebSocket: ${err.message}`)
    }

    debug('Websocket connection')
    return new Promise((resolve, reject) => {
      try {
        const wsOptions = { }

        if (this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_WEBSOCKET_HANDSHAKE_TIMEOUT]) {
          wsOptions.handshakeTimeout = this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_WEBSOCKET_HANDSHAKE_TIMEOUT]
        }

        const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy
        const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy
        const proxy = httpsProxy || httpProxy

        if (proxy) {
          debug(`Using proxy ${proxy}`)
          const proxyOptions = {}
          if (proxy.startsWith('https') || proxy.startsWith('http')) {
            const proxyUrl = new url.URL(proxy)
            proxyOptions.host = proxyUrl.hostname
            proxyOptions.port = proxyUrl.port
            proxyOptions.protocol = proxyUrl.protocol
          } else {
            if (httpsProxy) proxyOptions.protocol = 'https:'
            else proxyOptions.protocol = 'http:'
            if (proxy.indexOf(':') > 0) {
              proxyOptions.host = proxy.split(':')[0]
              proxyOptions.port = proxy.split(':')[1]
            } else {
              proxyOptions.host = proxy
            }
          }
          wsOptions.agent = new HttpsProxyAgent(proxyOptions)
        }

        this.ws = new WebSocket(websocketUrl, wsOptions)
        this.wsOpened = false
        this.ws.on('open', () => {
          this.wsOpened = true
          debug(`Websocket connection opened (options: ${JSON.stringify(wsOptions)}).`)
          if (this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY]) {
            debug('Websocket connection opened, sending welcome activity.')
            if (_.isString(this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY])) {
              let initActivity = null
              try {
                initActivity = JSON.parse(this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY])
              } catch (err) {
              }
              if (initActivity) {
                this.UserSays({ sourceData: initActivity }).catch(err => debug(`Failed to send DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY: ${err.message}`))
              } else {
                this.UserSays({ messageText: this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY] }).catch(err => debug(`Failed to send DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY: ${err.message}`))
              }
            } else {
              this.UserSays({ sourceData: this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY] }).catch(err => debug(`Failed to send DIRECTLINE_ORCHESTRATOR_WELCOME_ACTIVITY: ${err.message}`))
            }
          }

          resolve()
        })
        this.ws.on('close', () => {
          debug('Websocket connection closed.')
        })
        this.ws.on('error', (err) => {
          debug(err)
          if (!this.wsOpened) {
            reject(new Error(`Websocket connection (options: ${JSON.stringify(wsOptions)}) error: ${err.message || err}`))
          }
        })
        const isValidActivityType = (activityType) => {
          const filter = this.caps.DIRECTLINE_ORCHESTRATOR_HANDLE_ACTIVITY_TYPES
          if (_.isString(filter)) {
            return filter.indexOf(activityType) >= 0
          } else if (_.isArray(filter)) {
            return filter.findIndex(f => f === activityType) >= 0
          } else {
            return false
          }
        }

        this.ws.on('message', async (data) => {
          try {
            if (data) {
              const asJson = JSON.parse(data.toString('utf-8'))
              for (const activity of asJson.activities) {
                if (!isValidActivityType(activity.type)) {
                  debug(`Websocket connection skipped activity because type "${activity.type}" is not accepted. Message: ${JSON.stringify(activity)}.`)
                } else if (!this.wsOpened) {
                  debug(`Websocket connection skipped activity because websocket connection already closed. Message: ${JSON.stringify(activity)}.`)
                } else {
                  if (activity.id) {
                    if (this.receivedMessageIds[activity.id]) {
                      debug(`Websocket connection ignores already received message: ${JSON.stringify(activity)}`)
                    } else {
                      debug(`Websocket connection received message: ${JSON.stringify(activity)}`)
                      this.receivedMessageIds[activity.id] = true
                      const botMsg = this.delegateConnectorForConverting.ActivityToBotiumMsg(activity)
                      debug(`Websocket connection converted to botium message: ${JSON.stringify(Object.assign({}, botMsg, { sourceData: '...' }), null, 2)}`)
                      this._runInQueue(async () => {
                        const waitingForSemaphore = !!this.messageSendingSemaphorePromise
                        waitingForSemaphore && debug('Websocket connection waiting for semaphore start')
                        await (this.messageSendingSemaphorePromise || Promise.resolve())
                        waitingForSemaphore && debug('Websocket connection waiting for semaphore end')
                        this.queueBotSays(botMsg)
                      })
                    }
                  }
                }
              }
            } else {
              debug('Websocket connection received empty message, ignored.')
            }
          } catch (err) {
            debug(`Websocket connection failed to handle incoming message: "${err.message || err}" message: ${JSON.stringify(data)}}`)
          }
        })
      } catch (err) {
        debug(`Websocket connection setup failed: ${err.message}`)
        reject(new Error(`Websocket connection setup failed: ${err.message}`))
      }
    })
  }

  async UserSays (msg) {
    debug('UserSays called')

    const activity = this.delegateConnectorForConverting.BotiumMsgToActivity(msg, this.me)

    debug(`UserSays sending activity: ${JSON.stringify(activity, null, 2)}`)
    try {
      if (this.messageSendingSemaphorePromise) {
        debug('UserSays semaphore is not null!')
      }
      this.messageSendingSemaphorePromise = new Promise((resolve) => {
        this.messageSendingSemaphorePromiseResolve = resolve
      })
      const responseUserSays = await fetch(`${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_CONVERSATIONS_URL]}/${this.conversationId}/activities`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.token,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'user-agent': this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_USER_AGENT],
          cookie: `CID=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_CID]}; auth=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_AUTH]}; xptwj=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR_XPTWJ]}; _px3=${this.caps[Capabilities.DIRECTLINE_ORCHESTRATOR__PX3]}`
        },
        body: JSON.stringify(activity)
      })
      const userSaysData = await responseUserSays.text()

      debug(`UserSays response: ${userSaysData}`)
      if (!responseUserSays.ok) {
        throw new Error(`UserSays failed to send msg: "${JSON.stringify(msg)}" activity: "${JSON.stringify(activity)}" with error: ${responseUserSays.status} ${responseUserSays.statusText}`)
      }
    } catch (err) {
      debug(`UserSays failed with error: ${err.message}`)
      throw new Error(`UserSays failed with error: ${err.message}`)
    } finally {
      setTimeout(() => {
        if (this.messageSendingSemaphorePromiseResolve) {
          this.messageSendingSemaphorePromiseResolve()
          this.messageSendingSemaphorePromiseResolve = null
          this.messageSendingSemaphorePromise = null
        } else {
          debug('UserSays semaphore resolve not found!')
        }
      }, 0)
    }
  }

  async Stop () {
    debug('Stop called')
    if (this.ws) {
      this.ws.close()
    }
    this.wsOpened = false
    this.receivedMessageIds = null
    this.ws = null
    this.queue = null
    if (this.messageSendingSemaphorePromise) {
      debug('Stop semaphore is not null!')
      this.messageSendingSemaphorePromise = null
    }
    if (this.messageSendingSemaphorePromiseResolve) {
      debug('Stop semaphore resolve is not null!')
      this.messageSendingSemaphorePromiseResolve = null
    }
  }

  async Clean () {
    debug('Clean called')
    this.delegateConnectorForConverting = null
  }

  async _runInQueue (fn) {
    if (this.queue) {
      return new Promise((resolve, reject) => {
        this.queue.push(fn)
          .on('finish', resolve)
          .on('failed', reject)
      })
    } else {
      throw new Error('Connector not yet started')
    }
  }
}

module.exports = BotiumConnectorDirectlineOrchestrator
