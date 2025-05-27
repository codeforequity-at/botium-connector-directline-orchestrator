require('dotenv').config()
const assert = require('chai').assert
const Connector = require('../../src/connector')
const { readCaps } = require('./helper')

describe('connector', function () {
  beforeEach(async function () {
    this.timeout(20000)
    this.caps = readCaps()
    this.botMsgs = []
    const queueBotSays = (botMsg) => {
      if (this.botMsgPromiseResolve) {
        this.botMsgPromiseResolve(botMsg)
        this.botMsgPromiseResolve = null
      } else {
        this.botMsgs.push(botMsg)
      }
    }
    this.connector = new Connector({ queueBotSays, caps: this.caps })
    await this.connector.Validate()
    await this.connector.Build()
    await this.connector.Start()
    this._nextBotMsg = async () => {
      const nextBotMsg = this.botMsgs.shift()
      if (nextBotMsg) {
        return nextBotMsg
      }
      return new Promise(resolve => {
        this.botMsgPromiseResolve = resolve
      })
    }
  })


  it('hi shoud give some answer', async function () {

    await this.connector.UserSays({ messageText: 'hi' })

    const res = await this._nextBotMsg()
    assert.exists(res.messageText)
  }).timeout(25000)

  afterEach(async function () {
    await this.connector.Stop()
  })
})
