const PluginClass = require('./src/connector')

// TODO
// const logo = fs.readFileSync(path.join(__dirname, 'logo.ico')).toString('base64')

module.exports = {
  PluginVersion: 1,
  PluginClass: PluginClass,
  PluginDesc: {
    name: 'Directline Orchestrator',
    provider: 'Botium',
    capabilities: [
      {
        name: 'DIRECTLINE_ORCHESTRATOR_CID',
        label: 'CID',
        description: 'CID',
        type: 'string',
        required: true
      },
      {
        name: 'DIRECTLINE_ORCHESTRATOR_USER_AGENT',
        label: 'User Agent',
        description: 'User Agent',
        type: 'string',
        required: true
      },
      {
        name: 'DIRECTLINE_ORCHESTRATOR_AUTH',
        label: 'Auth',
        description: 'Auth',
        type: 'secret',
        required: true
      },
      {
        name: 'DIRECTLINE_ORCHESTRATOR_XPTWJ',
        label: 'XPTWJ',
        description: 'XPTWJ',
        type: 'string',
        required: true
      },
      {
        name: 'DIRECTLINE_ORCHESTRATOR__PX3',
        label: '_PX3',
        description: '_PX3',
        type: 'string',
        required: true
      },
      {
        name: 'DIRECTLINE_ORCHESTRATOR_TOKEN_URL',
        label: 'Token Url',
        description: 'Token Url',
        type: 'url',
        required: true
      },
      {
        name: 'DIRECTLINE_ORCHESTRATOR_CONVERSATIONS_URL',
        label: 'Token Url',
        description: 'Token Url',
        type: 'url',
        required: true
      }
    ],
    features: {
      sendAttachments: true,
      audioInput: true
    }
  }
}
