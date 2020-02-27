const path = require('path')
const { copySync } = require('fs-extra')
const { Component } = require('@serverless/core')
const {
  prepareInputs,
  getClients,
  createRole,
  getRole,
  removeRole,
  createLambdaFunction,
  updateLambdaFunctionCode,
  updateLambdaFunctionConfig,
  getLambdaFunction,
  deleteLambdaFunction
} = require('./utils')

class AwsLambda extends Component {
  /**
   * Deploy
   * @param {*} inputs
   */
  async deploy(inputs = {}) {
    // Check size of source code is less than 100MB
    if (this.size > 100000000) {
      throw new Error(
        'Your AWS Lambda source code size must be less than 100MB.  Try using Webpack, Parcel, AWS Lambda layers to reduce your code size.'
      )
    }

    // Prepare inputs
    inputs = prepareInputs(inputs, this)

    console.log(
      `Starting deployment of AWS Lambda "${inputs.name}" to the AWS region "${inputs.region}".`
    )

    // Get AWS clients
    const { lambda, iam } = getClients(this.credentials.aws, inputs.region)

    // Throw error on name change
    if (this.state.name && this.state.name !== inputs.name) {
      throw new Error(
        `Changing the name from ${this.state.name} to ${inputs.name} will delete the AWS Lambda function.  Please remove it manually, change the name, then re-deploy.`
      )
    }
    // Throw error on region change
    if (this.state.region && this.state.region !== inputs.region) {
      throw new Error(
        `Changing the region from ${this.state.region} to ${inputs.region} will delete the AWS Lambda function.  Please remove it manually, change the region, then re-deploy.`
      )
    }

    // If no AWS IAM Role role exists, auto-create a default role
    if (!inputs.roleArn) {
      console.log(
        `No AWS IAM Role provided. Creating/Updating default IAM Role with basic execution rights.`
      )
      const iamRoleName = `${inputs.name}-role`
      let res = await getRole(iam, iamRoleName)
      if (res) {
        inputs.autoRoleArn = this.state.autoRoleArn = res.Role.Arn
      } else {
        res = await createRole(iam, iamRoleName)
      }
      inputs.autoRoleArn = this.state.autoRoleArn = res.Role.Arn
    }

    // If user has put in a custom AWS IAM Role and an auto-created role exists, delete the auto-created role
    if (inputs.roleArn && this.state.autoRoleArn) {
      console.log('Detected a new roleArn has been provided.  Removing the auto-created role...')
      await removeRole(iam, this.state.autoRoleArn)
    }

    console.log(
      `Checking if an AWS Lambda function has already been created with name: ${inputs.name}`
    )
    const prevLambda = await getLambdaFunction(lambda, inputs.name)

    const filesPath = await this.unzip(inputs.src, true) // Returns directory with unzipped files

    if (!inputs.src) {
      copySync(path.join(__dirname, '_src'), filesPath)
      inputs.handler = 'handler.handler'
    }

    inputs.handler = this.addSDK(filesPath, inputs.handler) // Returns new handler
    inputs.src = await this.zip(filesPath, true) // Returns new zip

    // Create or update Lambda function
    if (!prevLambda) {
      // Create a Lambda function
      console.log(
        `Creating a new AWS Lambda function "${inputs.name}" in the "${inputs.region}" region.`
      )
      const createResult = await createLambdaFunction(lambda, inputs)
      inputs.arn = createResult.arn
      inputs.hash = createResult.hash
      console.log(`Successfully created an AWS Lambda function`)
    } else {
      // Update a Lambda function
      inputs.arn = prevLambda.arn
      console.log(`Updatinng ${inputs.name} AWS lambda function.`)
      await updateLambdaFunctionCode(lambda, inputs)
      await updateLambdaFunctionConfig(lambda, inputs)
      console.log(`Successfully updated AWS Lambda function`)
    }

    // Update state
    this.state.name = inputs.name
    this.state.arn = inputs.arn
    this.state.region = inputs.region

    return {
      name: inputs.name,
      arn: inputs.arn,
      securityGroupIds: inputs.securityGroupIds,
      subnetIds: inputs.subnetIds
    }
  }

  /**
   * Remove
   * @param {*} inputs
   */
  async remove(inputs = {}) {
    if (!this.state.name) {
      console.log(`No state found.  Function appears removed already.  Aborting.`)
      return
    }

    const { name, region } = this.state
    const { iam, lambda } = getClients(this.credentials.aws, region)

    if (this.state.autoRoleArn) {
      console.log(
        `Removing role that was automatically created for this function with ARN: ${this.state.autoRoleArn}.`
      )
      await removeRole(iam, this.state.autoRoleArn)
    }

    console.log(`Removing lambda ${name} from the ${region} region.`)
    await deleteLambdaFunction(lambda, name)
    console.log(`Successfully removed lambda ${name} from the ${region} region.`)
  }
}

/**
 * Exports
 */
module.exports = AwsLambda
