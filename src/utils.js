const AWS = require('aws-sdk')
const { tmpdir } = require('os')
const path = require('path')
const crypto = require('crypto')
const archiver = require('archiver')
const globby = require('globby')
const { contains, isNil, last, split, equals, not, pick, endsWith } = require('ramda')
const { readFile, createReadStream, createWriteStream } = require('fs-extra')
const fs = require('fs')

const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait))

const VALID_FORMATS = ['zip', 'tar']
const isValidFormat = (format) => contains(format, VALID_FORMATS)

const packDir = async (inputDirPath, outputFilePath, include = [], exclude = [], prefix) => {
  const format = last(split('.', outputFilePath))

  if (!isValidFormat(format)) {
    throw new Error('Please provide a valid format. Either a "zip" or a "tar"')
  }

  const patterns = ['**']

  if (!isNil(exclude)) {
    exclude.forEach((excludedItem) => patterns.push(`!${excludedItem}`))
  }

  const files = (await globby(patterns, { cwd: inputDirPath, dot: true }))
    .sort() // we must sort to ensure correct hash
    .map((file) => ({
      input: path.join(inputDirPath, file),
      output: prefix ? path.join(prefix, file) : file
    }))

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputFilePath)
    const archive = archiver(format, {
      zlib: { level: 9 }
    })

    output.on('open', () => {
      archive.pipe(output)

      // we must set the date to ensure correct hash
      files.forEach((file) =>
        archive.append(createReadStream(file.input), { name: file.output, date: new Date(0) })
      )

      if (!isNil(include)) {
        include.forEach((file) => {
          const stream = createReadStream(file)
          archive.append(stream, { name: path.basename(file), date: new Date(0) })
        })
      }

      archive.finalize()
    })

    archive.on('error', (err) => reject(err))
    output.on('close', () => resolve(outputFilePath))
  })
}

const getAccountId = async (aws) => {
  const STS = new aws.STS()
  const res = await STS.getCallerIdentity({}).promise()
  return res.Account
}

const randomId = Math.random()
  .toString(36)
  .substring(6)

const hashFile = async (filePath) =>
  crypto
    .createHash('sha256')
    .update(await readFile(filePath))
    .digest('base64')

const getClients = (credentials, region) => {
  const iam = new AWS.IAM({ credentials, region })
  const lambda = new AWS.Lambda({ credentials, region })

  return {
    iam,
    lambda
  }
}

const writeDevModeConfigFile = (config, instance) => {
  const devModeConfig = {
    platformStage: process.env.SERVERLESS_PLATFORM_STAGE,
    accessKey: instance.accessKey,
    instanceId: `${instance.org}.${instance.app}.${instance.stage}.${instance.name}`,
    userHandler: config.handler
  }

  const devModeConfigFilePath = path.join(config.src, `_devMode.json`)

  fs.writeFileSync(devModeConfigFilePath, JSON.stringify(devModeConfig), 'utf8')
}

const getConfig = (inputs, instance) => {
  const config = {
    name:
      inputs.name || instance.state.name || `aws-lambda-component-${instance.stage}-${randomId}`,
    roleArn: inputs.roleArn || instance.state.roleArn,
    roleName: `lambda-role-${instance.stage}-${randomId}`,
    description: inputs.description || 'AWS Lambda Component',
    memory: inputs.memory || 512,
    timeout: inputs.timeout || 10,
    src: inputs.src || process.cwd(),
    shims: inputs.shims || [],
    handler: inputs.handler || 'index.handler',
    runtime: 'nodejs12.x',
    env: inputs.env || {},
    region: inputs.region || 'us-east-1',
    securityGroupIds: inputs.vpcConfig ? inputs.vpcConfig.SecurityGroupIds : false,
    subnetIds: inputs.vpcConfig ? inputs.vpcConfig.SubnetIds : false
  }

  // setup dev mode
  // config.env.SERVERLESS_PLATFORM_STAGE = process.env.SERVERLESS_PLATFORM_STAGE
  // config.env.SERVERLESS_ACCESS_KEY = instance.accessKey
  // config.env.SERVERLESS_COMPONENT_INSTANCE_ID = `${instance.org}.${instance.app}.${instance.stage}.${instance.name}`
  // config.env.USER_HANDLER = config.handler

  writeDevModeConfigFile(config, instance)

  config.handler = '_handler.handler'

  return config
}

const createRole = async (iam, config) => {
  const assumeRolePolicyDocument = {
    Version: '2012-10-17',
    Statement: {
      Effect: 'Allow',
      Principal: {
        Service: ['lambda.amazonaws.com']
      },
      Action: 'sts:AssumeRole'
    }
  }
  const res = await iam
    .createRole({
      RoleName: config.roleName,
      Path: '/',
      AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicyDocument)
    })
    .promise()

  await iam
    .attachRolePolicy({
      RoleName: config.roleName,
      PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
    })
    .promise()

  return res.Role.Arn
}

const removeRole = async (iam, config) => {
  if (!config.roleArn) {
    return
  }
  try {
    await iam
      .detachRolePolicy({
        RoleName: config.roleArn.split('/')[1], // extract role name from arn
        PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
      })
      .promise()
    await iam
      .deleteRole({
        RoleName: config.roleArn.split('/')[1]
      })
      .promise()
  } catch (error) {
    if (error.code !== 'NoSuchEntity') {
      throw error
    }
  }
}

const createLambda = async (lambda, config) => {
  const params = {
    FunctionName: config.name,
    Code: {},
    Description: config.description,
    Handler: config.handler,
    MemorySize: config.memory,
    Publish: true,
    Role: config.roleArn,
    Runtime: config.runtime,
    Timeout: config.timeout,
    Environment: {
      Variables: config.env
    },
    ...(config.securityGroupIds && {
      VpcConfig: {
        SecurityGroupIds: config.securityGroupIds,
        SubnetIds: config.subnetIds
      }
    })
  }

  if (config.layer && config.layer.arn) {
    params.Layers = [config.layer.arn]
  }

  params.Code.ZipFile = await readFile(config.zipPath)

  try {
    const res = await lambda.createFunction(params).promise()
    return { arn: res.FunctionArn, hash: res.CodeSha256 }
  } catch (e) {
    if (e.message.includes(`The role defined for the function cannot be assumed by Lambda`)) {
      // we need to wait around 9 seconds after the role is craated before it can be assumed
      await sleep(1000)
      return createLambda(lambda, config)
    }
    throw e
  }
}

const updateLambdaConfig = async (lambda, config) => {
  const functionConfigParams = {
    FunctionName: config.name,
    Description: config.description,
    Handler: config.handler,
    MemorySize: config.memory,
    Role: config.roleArn,
    Runtime: config.runtime,
    Timeout: config.timeout,
    Environment: {
      Variables: config.env
    },
    ...(config.securityGroupIds
      ? {
          VpcConfig: {
            SecurityGroupIds: config.securityGroupIds,
            SubnetIds: config.subnetIds
          }
        }
      : {
          VpcConfig: {
            SecurityGroupIds: [],
            SubnetIds: []
          }
        })
  }

  if (config.layer && config.layer.arn) {
    functionConfigParams.Layers = [config.layer.arn]
  }

  const res = await lambda.updateFunctionConfiguration(functionConfigParams).promise()

  return { arn: res.FunctionArn, hash: res.CodeSha256 }
}

const updateLambdaCode = async (lambda, config) => {
  const functionCodeParams = {
    FunctionName: config.name,
    Publish: true
  }

  functionCodeParams.ZipFile = await readFile(config.zipPath)
  const res = await lambda.updateFunctionCode(functionCodeParams).promise()

  return res.FunctionArn
}

const getLambda = async ({ lambda, name }) => {
  try {
    const res = await lambda
      .getFunctionConfiguration({
        FunctionName: name
      })
      .promise()

    return {
      name: res.FunctionName,
      description: res.Description,
      timeout: res.Timeout,
      runtime: res.Runtime,
      role: {
        arn: res.Role
      },
      handler: res.Handler,
      memory: res.MemorySize,
      hash: res.CodeSha256,
      env: res.Environment ? res.Environment.Variables : {},
      arn: res.FunctionArn,
      securityGroupIds: res.VpcConfig ? res.VpcConfig.SecurityGroupIds : false,
      subnetIds: res.VpcConfig ? res.VpcConfig.SubnetIds : false
    }
  } catch (e) {
    if (e.code === 'ResourceNotFoundException') {
      return null
    }
    throw e
  }
}

const deleteLambda = async ({ lambda, name }) => {
  try {
    const params = { FunctionName: name }
    await lambda.deleteFunction(params).promise()
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      throw error
    }
  }
}

const getPolicy = async ({ name, region, accountId }) => {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Action: ['logs:CreateLogStream'],
        Resource: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${name}:*`],
        Effect: 'Allow'
      },
      {
        Action: ['logs:PutLogEvents'],
        Resource: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${name}:*:*`],
        Effect: 'Allow'
      }
    ]
  }
}

const configChanged = (prevLambda, lambda) => {
  const keys = [
    'description',
    'runtime',
    'roleArn',
    'handler',
    'memory',
    'timeout',
    'env',
    'hash',
    'securityGroupIds',
    'subnetIds'
  ]
  const inputs = pick(keys, lambda)
  const prevInputs = pick(keys, prevLambda)
  return not(equals(inputs, prevInputs))
}

const pack = async (code, shims = [], packDeps = true) => {
  if (endsWith('.zip', code) || endsWith('.tar', code)) {
    return path.resolve(code)
  }

  let exclude = []

  if (!packDeps) {
    exclude = ['node_modules/**']
  }

  const outputFilePath = path.join(
    tmpdir(),
    `${Math.random()
      .toString(36)
      .substring(6)}.zip`
  )

  const includeDirectory = path.join(__dirname, 'include')
  const devModeIncludes = [
    // dev-mode
    path.join(includeDirectory, 'centra.js'),
    path.join(includeDirectory, 'CentraRequest.js'),
    path.join(includeDirectory, 'CentraResponse.js'),
    path.join(includeDirectory, 'find-port.js'),
    path.join(includeDirectory, 'get-port.js'),
    path.join(includeDirectory, 'json-buffer.js'),
    path.join(includeDirectory, 'phin.js'),
    path.join(includeDirectory, 'sdk.js'),
    path.join(includeDirectory, 'streamLog.js'),
    path.join(includeDirectory, 'sync-rpc.js'),
    path.join(includeDirectory, 'worker.js'),
    path.join(includeDirectory, '_handler.js')
  ]

  return packDir(code, outputFilePath, shims.concat(devModeIncludes), exclude)
}

module.exports = {
  getConfig,
  getClients,
  createRole,
  removeRole,
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  getPolicy,
  getAccountId,
  configChanged,
  pack,
  hashFile
}
