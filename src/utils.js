const AWS = require('aws-sdk')
const { equals, not, pick } = require('ramda')
const { readFile } = require('fs-extra')

/**
 * Sleep
 * @param {*} wait 
 */
const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait))

/**
 * Get AWS Account ID
 * @param {*} aws 
 */
const getAccountId = async (aws) => {
  const STS = new aws.STS()
  const res = await STS.getCallerIdentity({}).promise()
  return res.Account
}

/**
 * Generate a random ID
 */
const randomId = Math.random()
  .toString(36)
  .substring(6)

/**
 * Get AWS SDK Clients
 * @param {*} credentials 
 * @param {*} region 
 */
const getClients = (credentials, region) => {
  const iam = new AWS.IAM({ credentials, region })
  const lambda = new AWS.Lambda({ credentials, region })
  return { iam, lambda }
}

/**
 * Prepare inputs
 * @param {*} inputs 
 * @param {*} instance 
 */
const prepareInputs = (inputs, instance) => {
  return {
    name:
      inputs.name || instance.state.name || `aws-lambda-component-${instance.stage}-${randomId}`,
    roleArn: inputs.roleArn || instance.state.roleArn,
    roleName: `lambda-role-${instance.stage}-${randomId}`,
    description: inputs.description || 'AWS Lambda Component',
    memory: inputs.memory || 1028,
    timeout: inputs.timeout || 10,
    src: inputs.src || process.cwd(),
    handler: inputs.handler || 'index.handler',
    runtime: 'nodejs12.x',
    env: inputs.env || {},
    region: inputs.region || 'us-east-1',
    layers: inputs.layers || [],
    securityGroupIds: inputs.vpcConfig ? inputs.vpcConfig.securityGroupIds : false,
    subnetIds: inputs.vpcConfig ? inputs.vpcConfig.subnetIds : false
  }
}

/**
 * Create an AWS IAM Role
 * @param {*} iam 
 * @param {*} config 
 */
const createRole = async (iam, roleName) => {
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

  let res = await iam
    .createRole({
      RoleName: roleName,
      Path: '/',
      AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicyDocument)
    })
    .promise()

  await iam
    .attachRolePolicy({
      RoleName: roleName,
      PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
    })
    .promise()

  return res
}

/**
 * Get an AWS IAM Role
 * @param {*} iam 
 * @param {*} config 
 */
const getRole = async (iam, roleName) => {
  let res
  try {
    res = await iam
    .getRole({
      RoleName: roleName
    })
    .promise()
  } catch(error) {
    if (error.code && error.code === 'NoSuchEntity') {
      return
    }
    throw error
  }
  return res
}

/**
 * Remove AWS IAM Role
 * @param {*} iam 
 * @param {*} config 
 */
const removeRole = async (iam, autoRoleArn) => {
  try {
    await iam
      .detachRolePolicy({
        RoleName: autoRoleArn.split('/')[1], // extract role name from arn
        PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
      })
      .promise()
    await iam
      .deleteRole({
        RoleName: autoRoleArn.split('/')[1]
      })
      .promise()
  } catch (error) {
    if (error.code !== 'NoSuchEntity') {
      throw error
    }
  }
}

/**
 * Create a new lambda function
 * @param {*} lambda 
 * @param {*} config 
 */
const createLambdaFunction = async (lambda, inputs) => {
  const params = {
    FunctionName: inputs.name,
    Code: {},
    Description: inputs.description,
    Handler: inputs.handler,
    MemorySize: inputs.memory,
    Publish: true,
    Role: inputs.roleArn || inputs.autoRoleArn,
    Runtime: inputs.runtime,
    Timeout: inputs.timeout,
    Layers: inputs.layers,
    Environment: {
      Variables: inputs.env
    },
    ...(inputs.securityGroupIds && {
      VpcConfig: {
        SecurityGroupIds: inputs.securityGroupIds,
        SubnetIds: inputs.subnetIds
      }
    })
  }

  params.Code.ZipFile = await readFile(inputs.src)

  try {
    const res = await lambda.createFunction(params).promise()
    return { arn: res.FunctionArn, hash: res.CodeSha256 }
  } catch (e) {
    if (e.message.includes(`The role defined for the function cannot be assumed by Lambda`)) {
      // we need to wait after the role is created before it can be assumed
      await sleep(5000)
      return await createLambdaFunction(lambda, inputs)
    }
    throw e
  }
}

/**
 * Update Lambda configuration
 * @param {*} lambda 
 * @param {*} config 
 */
const updateLambdaFunctionConfig = async (lambda, inputs) => {
  const functionConfigParams = {
    FunctionName: inputs.name,
    Description: inputs.description,
    Handler: inputs.handler,
    MemorySize: inputs.memory,
    Role: inputs.roleArn || inputs.autoRoleArn,
    Runtime: inputs.runtime,
    Timeout: inputs.timeout,
    Layers: inputs.layers,
    Environment: {
      Variables: inputs.env
    },
    ...(inputs.securityGroupIds
      ? {
          VpcConfig: {
            SecurityGroupIds: inputs.securityGroupIds,
            SubnetIds: inputs.subnetIds
          }
        }
      : {
          VpcConfig: {
            SecurityGroupIds: [],
            SubnetIds: []
          }
        })
  }

  const res = await lambda.updateFunctionConfiguration(functionConfigParams).promise()
  return { arn: res.FunctionArn, hash: res.CodeSha256 }
}

/**
 * Update Lambda function code
 * @param {*} lambda 
 * @param {*} config 
 */
const updateLambdaFunctionCode = async (lambda, inputs) => {
  const functionCodeParams = {
    FunctionName: inputs.name,
    Publish: true
  }

  functionCodeParams.ZipFile = await readFile(inputs.src)
  const res = await lambda.updateFunctionCode(functionCodeParams).promise()

  return res.FunctionArn
}

/**
 * Get Lambda Function
 * @param {*} lambda 
 * @param {*} functionName 
 */
const getLambdaFunction = async (lambda, functionName) => {
  try {
    const res = await lambda
      .getFunctionConfiguration({
        FunctionName: functionName
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

/**
 * Delete Lambda function
 * @param {*} param0 
 */
const deleteLambdaFunction = async (lambda, functionName) => {
  try {
    const params = { FunctionName: functionName }
    await lambda.deleteFunction(params).promise()
  } catch (error) {
    console.log(error)
    if (error.code !== 'ResourceNotFoundException') {
      throw error
    }
  }
}

/**
 * Get AWS IAM role policy
 * @param {*} param0 
 */
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

/**
 * Detect if inputs have changed
 * @param {*} prevLambda 
 * @param {*} lambda 
 */
const inputsChanged = (prevLambda, lambda) => {
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

/**
 * Exports
 */
module.exports = {
  prepareInputs,
  getClients,
  createRole,
  getRole,
  removeRole,
  createLambdaFunction,
  updateLambdaFunctionCode,
  updateLambdaFunctionConfig,
  getLambdaFunction,
  deleteLambdaFunction,
  getPolicy,
  getAccountId,
  inputsChanged,
}
