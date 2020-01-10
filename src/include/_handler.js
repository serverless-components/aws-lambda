async function handler(event, context) {
  require('./sdk')

  const userHandler = process.env.USER_HANDLER
  const userHandlerFilePath = `./${userHandler.split('.')[0]}`
  const userHandlerFunctionName = userHandler.split('.')[1]

  const userHandlerFile = require(userHandlerFilePath)

  return userHandlerFile[userHandlerFunctionName](event, context)
}

exports.handler = handler
