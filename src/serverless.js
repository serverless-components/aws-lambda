const { Component } = require('@serverless/core')
const {
  getConfig,
  getClients,
  createRole,
  removeRole,
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  configChanged,
  pack,
  hashFile
} = require('./utils')

class AwsLambda extends Component {
  async deploy(inputs = {}) {
    await this.status(`Deploying`)

    const config = getConfig(inputs, this)

    await this.debug(`Starting deployment of lambda ${config.name} to the ${config.region} region.`)

    const { lambda, iam } = getClients(this.credentials.aws, config.region)

    // If no role exists, create a default role
    if (!config.roleArn) {
      await this.debug(
        `No role provided for lambda ${config.name}.  Creating/Updating default IAM Role with basic execution rights...`
      )
      config.roleArn = await createRole(iam, config)
      this.state.roleArn = config.roleArn
      await this.save()
    }

    await this.status('Packaging')
    await this.debug(`Packaging lambda code from ${config.src}.`)
    config.zipPath = await pack(config.src, config.shims)

    config.hash = await hashFile(config.zipPath)

    const prevLambda = await getLambda({ lambda, ...config })

    if (!prevLambda) {
      await this.status(`Creating`)
      await this.debug(`Creating lambda ${config.name} in the ${config.region} region.`)

      const createResult = await createLambda(lambda, config)
      config.arn = createResult.arn
      config.hash = createResult.hash
      if (createResult.vpcConfig && createResult.vpcConfig.VpcId) {
        config.vpcId = createResult.vpcConfig.VpcId
        config.securityGroupIds = createResult.vpcConfig.SecurityGroupIds
        config.subnetIds = createResult.vpcConfig.SubnetIds
      } else {
        config.vpcId = false
        config.securityGroupIds = false
        config.subnetIds = false
      }
    } else {
      config.arn = prevLambda.arn

      if (configChanged(prevLambda, config)) {
        if (prevLambda.hash !== config.hash) {
          await this.status(`Uploading code`)
          await this.debug(`Uploading ${config.name} lambda code.`)
          await updateLambdaCode(lambda, config)
        }

        await this.status(`Updating`)
        await this.debug(`Updating ${config.name} lambda config.`)

        const updateResult = await updateLambdaConfig(lambda, config)
        config.hash = updateResult.hash
        if (updateResult.vpcConfig.VpcId) {
          config.vpcId = updateResult.vpcConfig.VpcId
          config.securityGroupIds = updateResult.vpcConfig.SecurityGroupIds
          config.subnetIds = updateResult.vpcConfig.SubnetIds
        } else {
          config.vpcId = false
          config.securityGroupIds = false
          config.subnetIds = false
        }
      }
    }

    // todo we probably don't need this logic now that we auto generate names
    if (this.state.name && this.state.name !== config.name) {
      await this.status(`Replacing`)
      await deleteLambda({ lambda, name: this.state.name })
    }

    await this.debug(`Successfully deployed lambda ${config.name} in the ${config.region} region.`)

    this.state = config
    await this.save()

    return {
      name: config.name,
      arn: config.arn
    }
  }

  async publishVersion() {
    const { name, region, hash } = this.state

    const { lambda } = getClients(this.credentials.aws, region)

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

    const { iam, lambda } = getClients(this.credentials.aws, region)

    if (this.state.roleArn) {
      await this.debug(`Removing role with arn ${this.state.roleArn}.`)
      await removeRole(iam, this.state)
    }

    await this.debug(`Removing lambda ${name} from the ${region} region.`)
    await deleteLambda({ lambda, name })
    await this.debug(`Successfully removed lambda ${name} from the ${region} region.`)

    this.state = {}
    await this.save()
  }
}

module.exports = AwsLambda
