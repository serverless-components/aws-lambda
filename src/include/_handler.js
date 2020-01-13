async function handler(event, context) {
  // setup dev mode
  const devModeConfig = require('./_devMode.json')

  process.env.SERVERLESS_PLATFORM_STAGE = devModeConfig.platformStage
  process.env.SERVERLESS_ACCESS_KEY = devModeConfig.accessKey
  process.env.SERVERLESS_COMPONENT_INSTANCE_ID = devModeConfig.instanceId
  process.env.USER_HANDLER = devModeConfig.userHandler

  require('./sdk')

  const userHandler = process.env.USER_HANDLER
  const userHandlerFilePath = `./${userHandler.split('.')[0]}`
  const userHandlerFunctionName = userHandler.split('.')[1]

  const userHandlerFile = require(userHandlerFilePath)

  return userHandlerFile[userHandlerFunctionName](event, context)
}

exports.handler = handler
