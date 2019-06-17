const path = require('path')
const aws = require('aws-sdk')
const AwsSdkLambda = aws.Lambda
const { mergeDeepRight, pick } = require('ramda')
const { Component, utils } = require('@serverless/core')
const {
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  configChanged,
  pack
} = require('./utils')

const outputsList = [
  'name',
  'description',
  'memory',
  'timeout',
  'code',
  'bucket',
  'shims',
  'handler',
  'runtime',
  'env',
  'role',
  'layer',
  'arn'
]

const defaults = {
  name: 'serverless',
  description: 'AWS Lambda Component',
  memory: 512,
  timeout: 10,
  code: process.cwd(),
  bucket: undefined,
  shims: [],
  handler: 'handler.hello',
  runtime: 'nodejs8.10',
  env: {},
  region: 'us-east-1'
}

class AwsLambda extends Component {
  async default(inputs = {}) {
    const config = mergeDeepRight(defaults, inputs)

    this.context.status(`Deploying`)

    const lambda = new AwsSdkLambda({
      region: config.region,
      credentials: this.context.credentials.aws
    })

    const awsIamRole = await this.load('@serverless/aws-iam-role')

    // If no role exists, create a default role
    let outputsAwsIamRole
    if (!config.role) {
      outputsAwsIamRole = await awsIamRole({
        name: config.name,
        service: 'lambda.amazonaws.com',
        policy: {
          arn: 'arn:aws:iam::aws:policy/AdministratorAccess'
        }
      })
      config.role = { arn: outputsAwsIamRole.arn }
    } else {
      outputsAwsIamRole = await awsIamRole(config.role)
      config.role = { arn: outputsAwsIamRole.arn }
    }

    if (
      config.bucket &&
      config.runtime === 'nodejs8.10' &&
      (await utils.dirExists(path.join(config.code, 'node_modules')))
    ) {
      const layer = await this.load('@serverless/aws-lambda-layer')

      const layerInputs = {
        name: `${config.name}-dependencies`,
        description: `${config.name} Dependencies Layer`,
        code: path.join(config.code, 'node_modules'),
        runtimes: ['nodejs8.10'],
        prefix: 'nodejs/node_modules',
        bucket: config.bucket,
        region: config.region
      }

      this.context.status('Deploying Dependencies')
      const promises = [pack(config.code, config.shims, false), layer(layerInputs)]
      const res = await Promise.all(promises)
      config.zipPath = res[0]
      config.layer = res[1]
    } else {
      this.context.status('Packaging')
      config.zipPath = await pack(config.code, config.shims)
    }

    config.hash = await utils.hashFile(config.zipPath)

    let deploymentBucket
    if (config.bucket) {
      deploymentBucket = await this.load('@serverless/aws-s3')
    }

    const prevLambda = await getLambda({ lambda, ...config })

    if (!prevLambda) {
      if (config.bucket) {
        this.context.status(`Uploading`)
        await deploymentBucket.upload({ name: config.bucket, file: config.zipPath })
      }

      this.context.status(`Creating`)
      config.arn = await createLambda({ lambda, ...config })
    } else {
      config.arn = prevLambda.arn
      if (configChanged(prevLambda, config)) {
        if (config.bucket && prevLambda.hash !== config.hash) {
          this.context.status(`Uploading`)
          await deploymentBucket.upload({ name: config.bucket, file: config.zipPath })
          await updateLambdaCode({ lambda, ...config })
        }
        this.context.status(`Updating`)
        await updateLambdaConfig({ lambda, ...config })
      }
    }

    if (this.state.name && this.state.name !== config.name) {
      this.context.status(`Replacing`)
      await deleteLambda({ lambda, name: this.state.name })
    }

    this.state.name = config.name
    this.state.arn = config.arn
    await this.save()

    const outputs = pick(outputsList, config)

    this.context.log()
    this.context.output('name', `       ${outputs.name}`)
    this.context.output('description', `${outputs.description}`)
    this.context.output('memory', `     ${outputs.memory}`)
    this.context.output('timeout', `    ${outputs.timeout}`)
    this.context.output('arn', `        ${outputs.arn}`)

    return outputs
  }

  async remove(inputs = {}) {
    const config = mergeDeepRight(defaults, inputs)
    config.name = inputs.name || this.state.name || defaults.name

    const lambda = new AwsSdkLambda({
      region: config.region,
      credentials: this.context.credentials.aws
    })

    this.context.status(`Removing`)

    const awsIamRole = await this.load('@serverless/aws-iam-role')
    const layer = await this.load('@serverless/aws-lambda-layer')

    // there's no need to pass names as input
    // since it's saved in the child component state
    await awsIamRole.remove()
    await layer.remove()

    await deleteLambda({ lambda, name: config.name })

    this.state = {}
    await this.save()

    return {}
  }
}

module.exports = AwsLambda
