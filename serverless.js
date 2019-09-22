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
  'hash',
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
  'arn',
  'region'
]

const defaults = {
  description: 'A Function deployed via the AWS Lambda Component',
  memory: 512,
  timeout: 10,
  code: process.cwd(),
  bucket: undefined,
  shims: [],
  handler: 'handler.hello',
  runtime: 'nodejs10.x',
  env: {},
  region: 'us-east-1'
}

class AwsLambda extends Component {

  /**
   * Default
   */

  async default(inputs = {}) {
    this.context.status(`Deploying`)

    const config = mergeDeepRight(defaults, inputs)

    config.name = this.state.name || this.context.resourceId()

    this.context.debug(
      `Starting deployment of lambda ${config.name} to the ${config.region} region.`
    )

    const lambda = new AwsSdkLambda({
      region: config.region,
      credentials: this.context.credentials.aws
    })

    const awsIamRole = await this.load('@serverless/aws-iam-role')

    // If no role exists, create a default role
    let outputsAwsIamRole
    if (!config.role) {
      this.context.debug(`No role provided for lambda ${config.name}.`)

      outputsAwsIamRole = await awsIamRole({
        service: 'lambda.amazonaws.com',
        policy: {
          arn: 'arn:aws:iam::aws:policy/AdministratorAccess'
        },
        region: config.region
      })
      config.role = { arn: outputsAwsIamRole.arn }
    } else {
      outputsAwsIamRole = await awsIamRole(config.role)
      config.role = { arn: outputsAwsIamRole.arn }
    }

    if (
      config.bucket &&
      config.runtime === 'nodejs10.x' &&
      (await utils.dirExists(path.join(config.code, 'node_modules')))
    ) {
      this.context.debug(`Bucket ${config.bucket} is provided for lambda ${config.name}.`)

      const layer = await this.load('@serverless/aws-lambda-layer')

      const layerInputs = {
        description: `${config.name} Dependencies Layer`,
        code: path.join(config.code, 'node_modules'),
        runtimes: ['nodejs10.x'],
        prefix: 'nodejs/node_modules',
        bucket: config.bucket,
        region: config.region
      }

      this.context.status('Deploying Dependencies')
      this.context.debug(`Packaging lambda code from ${config.code}.`)
      this.context.debug(`Uploading dependencies as a layer for lambda ${config.name}.`)

      const promises = [pack(config.code, config.shims, false), layer(layerInputs)]
      const res = await Promise.all(promises)
      config.zipPath = res[0]
      config.layer = res[1]
    } else {
      this.context.status('Packaging')
      this.context.debug(`Packaging lambda code from ${config.code}.`)
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
        this.context.debug(`Uploading ${config.name} lambda package to bucket ${config.bucket}.`)
        this.context.status(`Uploading`)

        await deploymentBucket.upload({ name: config.bucket, file: config.zipPath })
      }

      this.context.status(`Creating`)
      this.context.debug(`Creating lambda ${config.name} in the ${config.region} region.`)

      const createResult = await createLambda({ lambda, ...config })
      config.arn = createResult.arn
      config.hash = createResult.hash
    } else {
      config.arn = prevLambda.arn

      if (configChanged(prevLambda, config)) {
        if (config.bucket && prevLambda.hash !== config.hash) {
          this.context.status(`Uploading code`)
          this.context.debug(`Uploading ${config.name} lambda code to bucket ${config.bucket}.`)

          await deploymentBucket.upload({ name: config.bucket, file: config.zipPath })
          await updateLambdaCode({ lambda, ...config })
        } else if (!config.bucket && prevLambda.hash !== config.hash) {
          this.context.status(`Uploading code`)
          this.context.debug(`Uploading ${config.name} lambda code.`)
          await updateLambdaCode({ lambda, ...config })
        }

        this.context.status(`Updating`)
        this.context.debug(`Updating ${config.name} lambda config.`)

        const updateResult = await updateLambdaConfig({ lambda, ...config })
        config.hash = updateResult.hash
      }
    }

    // todo we probably don't need this logic now thatt we auto generate names
    if (this.state.name && this.state.name !== config.name) {
      this.context.status(`Replacing`)
      await deleteLambda({ lambda, name: this.state.name })
    }

    this.context.debug(
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
      credentials: this.context.credentials.aws
    })

    const { Version } = await lambda
      .publishVersion({
        FunctionName: name,
        CodeSha256: hash
      })
      .promise()

    return { version: Version }
  }

  /**
   * Remove
   */

  async remove(inputs = {}) {
    this.context.status(`Removing`)

    if (!this.state.name) {
      this.context.debug(`Aborting removal. Function name not found in state.`)
      return
    }

    const { name, region } = this.state

    const lambda = new AwsSdkLambda({
      region,
      credentials: this.context.credentials.aws
    })

    const awsIamRole = await this.load('@serverless/aws-iam-role')
    const layer = await this.load('@serverless/aws-lambda-layer')

    await awsIamRole.remove()
    await layer.remove()

    this.context.debug(`Removing lambda ${name} from the ${region} region.`)
    await deleteLambda({ lambda, name })
    this.context.debug(`Successfully removed lambda ${name} from the ${region} region.`)

    const outputs = pick(outputsList, this.state)

    this.state = {}
    await this.save()

    return outputs
  }

  /**
   * Logs
   */

  async logs(inputs = { nextToken: null }) {

    // Ensure this has been deployed
    if (!this.state.name) {
      throw new Error(`This function has not been deployed.`)
    }

    inputs.nextToken = inputs.nextToken || null
    if (!inputs.startTime || !inputs.endTime) {
      inputs.startTime = new Date(new Date().getTime() - (24 * 60 * 60 * 1000))
      inputs.startTime = inputs.startTime.toISOString()
      inputs.endTime = new Date()
      inputs.endTime = inputs.endTime.toISOString()
    }

    // Init AWS SDK
    aws.config.apiVersions = {
      cloudwatchlogs: '2014-03-28',
    }
    const cwLogs = new aws.CloudWatchLogs({
      region: this.state.region
    })

    // Log Group Name
    const logGroupName = `/aws/lambda/${this.state.name}`

    const streamParams = {
      logGroupName: logGroupName,
      descending: true,
      limit: '10',
      orderBy: 'LastEventTime',
    }

    let streams
    try {
      streams = await cwLogs.describeLogStreams(streamParams).promise()
    } catch (error) {
      if (error.code.includes('ResourceNotFoundException')) {
        throw new Error(`Logs are not available for the Function ${this.state.name}.  This is usually because it has not yet been called.`)
      } else {
        throw new Error(error)
      }
    }

    const latestStream = streams.logStreams[0]

    const eventsParams = {
      logGroupName: logGroupName, /* required */
      logStreamName: latestStream.logStreamName, /* required */
      nextToken: inputs.nextToken,
      startFromHead: true,
    }
    let logs
    try {
      logs = await cwLogs.getLogEvents(eventsParams).promise()
    } catch (error) {
      throw new Error(error)
    }

    // Put data into standard format
    const results = logs.events
    .filter((event) => {
      if (
        event.message.includes('START RequestId: ') ||
        event.message.includes('END RequestId: ') ||
        event.message.includes('REPORT RequestId: ')
      ) {
        return false
      } else {
        return true
      }
    })
    .map((event) => {

      let timestamp
      let message
      let meta = {}
      timestamp = event.message.split(`\t`)[0]
      meta.requestId = event.message.split(`\t`)[1]
      meta.type = event.message.split(`\t`)[2]
      message = event.message.split(`\t`)[3]

      return {
        timestamp,
        message,
        meta
      }
    })

    return {
      logs: results
    }
  }

  /**
   * Metrics
   */

  async metrics(inputs = {}) {

    // Ensure this has been deployed
    if (!this.state.name) {
      throw new Error(`This function has not been deployed.`)
    }

    inputs.nextToken = null
    if (!inputs.startTime || !inputs.endTime) {
      inputs.startTime = new Date(new Date().getTime() - (24 * 60 * 60 * 1000))
      inputs.startTime = inputs.startTime.toISOString()
      inputs.endTime = new Date()
      inputs.endTime = inputs.endTime.toISOString()
    }

    const cloudwatch = new aws.CloudWatch({
      region: this.state.region
    })

    const params = {
      StartTime: inputs.startTime,
      EndTime: inputs.endTime,
      NextToken: inputs.nextToken,
      ScanBy: 'TimestampDescending',
      MetricDataQueries: [
        {
          Id: `metric_alias0`,
          MetricStat: {
            Metric: {
              Dimensions: [
                {
                  Name: 'FunctionName',
                  Value: `${this.state.name}`
                },
              ],
              MetricName: 'Invocations',
              Namespace: 'AWS/Lambda'
            },
            Period: 300,
            Stat: 'Sum',
            Unit: 'Count',
          },
          ReturnData: true
        },
        {
          Id: `metric_alias1`,
          MetricStat: {
            Metric: {
              Dimensions: [
                {
                  Name: 'FunctionName',
                  Value: `${this.state.name}`
                },
              ],
              MetricName: 'Errors',
              Namespace: 'AWS/Lambda'
            },
            Period: 300,
            Stat: 'Sum',
            Unit: 'Count',
          },
          ReturnData: true
        },
        {
          Id: `metric_alias2`,
          MetricStat: {
            Metric: {
              Dimensions: [
                {
                  Name: 'FunctionName',
                  Value: `${this.state.name}`
                },
              ],
              MetricName: 'Duration',
              Namespace: 'AWS/Lambda'
            },
            Period: 300,
            Stat: 'Average',
            Unit: 'Milliseconds',
          },
          ReturnData: true
        },
        {
          Id: `metric_alias3`,
          MetricStat: {
            Metric: {
              Dimensions: [
                {
                  Name: 'FunctionName',
                  Value: `${this.state.name}`
                },
              ],
              MetricName: 'Duration',
              Namespace: 'AWS/Lambda'
            },
            Period: 300,
            Stat: 'p95',
            Unit: 'Milliseconds',
          },
          ReturnData: true
        },
        {
          Id: `metric_alias4`,
          MetricStat: {
            Metric: {
              Dimensions: [
                {
                  Name: 'FunctionName',
                  Value: `${this.state.name}`
                },
              ],
              MetricName: 'Throttles',
              Namespace: 'AWS/Lambda'
            },
            Period: 300,
            Stat: 'Sum',
            Unit: 'Count',
          },
          ReturnData: true
        },
      ]
    }

    const cwMetrics = await cloudwatch.getMetricData(params).promise()

    // Put data into standard format
    const metrics = []

    const invocations = {
      type: 'keyVal', // type of data
      name: 'Invocations',
      keys: [],
      values: [],
    }
    if (cwMetrics.MetricDataResults && cwMetrics.MetricDataResults[0]) {
      invocations.keys = cwMetrics.MetricDataResults[0].Timestamps
      invocations.values = cwMetrics.MetricDataResults[0].Values
    }
    metrics.push(invocations)

    const errors = {
      type: 'keyVal', // type of data
      name: 'Errors',
      keys: [],
      values: [],
    }
    if (cwMetrics.MetricDataResults && cwMetrics.MetricDataResults[1]) {
      errors.keys = cwMetrics.MetricDataResults[1].Timestamps
      errors.values = cwMetrics.MetricDataResults[1].Values
    }
    metrics.push(errors)

    const durations = {
      type: 'keyVal', // type of data
      name: 'Durations',
      keys: [],
      values: [],
    }
    if (cwMetrics.MetricDataResults && cwMetrics.MetricDataResults[2]) {
      durations.keys = cwMetrics.MetricDataResults[2].Timestamps
      durations.values = cwMetrics.MetricDataResults[2].Values
    }
    metrics.push(durations)

    const durationp95s = {
      type: 'keyVal', // type of data
      name: 'Duration P95',
      keys: [],
      values: [],
    }
    if (cwMetrics.MetricDataResults && cwMetrics.MetricDataResults[3]) {
      durationp95s.keys = cwMetrics.MetricDataResults[3].Timestamps
      durationp95s.values = cwMetrics.MetricDataResults[3].Values
    }
    metrics.push(durationp95s)

    const throttles = {
      type: 'keyVal', // type of data
      name: 'Throttles',
      keys: [],
      values: [],
    }
    if (cwMetrics.MetricDataResults && cwMetrics.MetricDataResults[4]) {
      throttles.keys = cwMetrics.MetricDataResults[4].Timestamps
      throttles.values = cwMetrics.MetricDataResults[4].Values
    }
    metrics.push(throttles)

    return { metrics }
  }
}

module.exports = AwsLambda
