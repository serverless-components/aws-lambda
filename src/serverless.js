const aws = require('aws-sdk')
const AwsSdkLambda = aws.Lambda
const { mergeDeepRight, pick } = require('ramda')
const { Component } = require('@serverless/core')
const {
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  configChanged,
  pack,
  hashFile,
} = require('./utils')

const outputsList = [
  'name',
  'hash',
  'description',
  'memory',
  'timeout',
  'code',
  'shims',
  'handler',
  'runtime',
  'env',
  'role',
  'arn',
  'region'
]

const defaults = {
  description: 'AWS Lambda Component',
  memory: 512,
  timeout: 10,
  code: process.cwd(),
  shims: [],
  handler: 'handler.hello',
  runtime: 'nodejs10.x',
  env: {},
  region: 'us-east-1'
}

class AwsLambda extends Component {
  async deploy(inputs = {}) {
    await this.status(`Deploying`)

    const config = mergeDeepRight(defaults, inputs)
    const randomId = Math.random().toString(36).substring(6)
    config.name = this.state.name || inputs.name || `aws-lambda-component-${this.stage}-${randomId}`

    await this.debug(`Starting deployment of lambda ${config.name} to the ${config.region} region.`)

    const lambda = new AwsSdkLambda({
      region: config.region,
      credentials: this.credentials.aws
    })

    await this.debug(`Loading AWS IAM Role`)
    const awsIamRole = this.load('aws-iam-role@0.0.4', 'role')

    // If no role exists, create a default role
    let outputsAwsIamRole
    if (!config.role) {
      await this.debug(`No role provided for lambda ${config.name}.  Creating/Updating default IAM Role with basic execution rights...`)
      outputsAwsIamRole = await awsIamRole.deploy({
        name: config.name, // Create a default role with the same name as the function
        service: 'lambda.amazonaws.com',
        policy: {
          arn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        },
        region: config.region,
      })
      config.role = this.state.defaultRole = { arn: outputsAwsIamRole.arn }
      await this.save()
    } else {
      outputsAwsIamRole = await awsIamRole.deploy(config.role)
      config.role = { arn: outputsAwsIamRole.arn }
    }

    await this.status('Packaging')
    await this.debug(`Packaging lambda code from ${config.src}.`)
    config.zipPath = await pack(config.src, config.shims)

    config.hash = await hashFile(config.zipPath)

    const prevLambda = await getLambda({ lambda, ...config })

    if (!prevLambda) {
      await this.status(`Creating`)
      await this.debug(`Creating lambda ${config.name} in the ${config.region} region.`)

      const createResult = await createLambda({ lambda, ...config })
      config.arn = createResult.arn
      config.hash = createResult.hash
    } else {
      config.arn = prevLambda.arn

      if (configChanged(prevLambda, config)) {
        if (prevLambda.hash !== config.hash) {
          await this.status(`Uploading code`)
          await this.debug(`Uploading ${config.name} lambda code.`)
          await updateLambdaCode({ lambda, ...config })
        }

        await this.status(`Updating`)
        await this.debug(`Updating ${config.name} lambda config.`)

        const updateResult = await updateLambdaConfig({ lambda, ...config })
        config.hash = updateResult.hash
      }
    }

    // todo we probably don't need this logic now thatt we auto generate names
    if (this.state.name && this.state.name !== config.name) {
      await this.status(`Replacing`)
      await deleteLambda({ lambda, name: this.state.name })
    }

    await this.debug(
      `Successfully deployed lambda ${config.name} in the ${config.region} region.`
    )

    const outputs = pick(outputsList, config)

    this.state = outputs
    await this.save()

    return outputs
  }

  async publishVersion() {
    const { name, region, hash } = this.state

    const lambda = new AwsSdkLambda({
      region,
      credentials: this.credentials.aws
    })

    const { Version } = await lambda
      .publishVersion({
        FunctionName: name,
        CodeSha256: hash
      })
      .promise()

    return { version: Version }
  }

  async remove() {
    await this.status(`Removing`)

    if (!this.state.name) {
      await this.debug(`No state found.  Function appears removed already.  Aborting.`)
      return
    }

    const { name, region } = this.state

    const lambda = new AwsSdkLambda({
      region,
      credentials: this.credentials.aws
    })

    if (this.state.defaultRole) {
      const awsIamRole = this.load('aws-iam-role', 'role')
      await awsIamRole.remove()
    }

    await this.debug(`Removing lambda ${name} from the ${region} region.`)
    await deleteLambda({ lambda, name })
    await this.debug(`Successfully removed lambda ${name} from the ${region} region.`)

    const outputs = pick(outputsList, this.state)

    this.state = {}
    await this.save()

    return outputs
  }
}

module.exports = AwsLambda
