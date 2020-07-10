const path = require('path')
const { copySync } = require('fs-extra')
const { Component } = require('@serverless/core')
const {
  prepareInputs,
  getClients,
  createLambdaFunction,
  updateLambdaFunctionCode,
  updateLambdaFunctionConfig,
  getLambdaFunction,
  createOrUpdateFunctionRole,
  createOrUpdateMetaRole,
  deleteLambdaFunction,
  removeAllRoles,
  getMetrics,
} = require('./utils')

class AwsLambda extends Component {
  /**
   * Deploy
   * @param {*} inputs
   */
  async deploy(inputs = {}) {
    // this error message assumes that the user is running via the CLI though...
    if (Object.keys(this.credentials.aws).length === 0) {
      const msg = `Credentials not found. Make sure you have a .env file in the cwd. - Docs: https://git.io/JvArp`
      throw new Error(msg)
    }

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
    const clients = getClients(this.credentials.aws, inputs.region)

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

    await Promise.all([
      createOrUpdateFunctionRole(this, inputs, clients),
      createOrUpdateMetaRole(this, inputs, clients, this.accountId),
    ]);

    console.log(
      `Checking if an AWS Lambda function has already been created with name: ${inputs.name}`
    )
    const prevLambda = await getLambdaFunction(clients.lambda, inputs.name)

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
      const createResult = await createLambdaFunction(this, clients.lambda, inputs)
      inputs.arn = createResult.arn
      inputs.hash = createResult.hash
      console.log(`Successfully created an AWS Lambda function`)
    } else {
      // Update a Lambda function
      inputs.arn = prevLambda.arn
      console.log(`Updating ${inputs.name} AWS lambda function.`)
      await updateLambdaFunctionCode(clients.lambda, inputs)
      await updateLambdaFunctionConfig(this, clients.lambda, inputs)
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

    // this error message assumes that the user is running via the CLI though...
    if (Object.keys(this.credentials.aws).length === 0) {
      const msg = `Credentials not found. Make sure you have a .env file in the cwd. - Docs: https://git.io/JvArp`
      throw new Error(msg)
    }

    if (!this.state.name) {
      console.log(`No state found.  Function appears removed already.  Aborting.`)
      return
    }

    const clients = getClients(this.credentials.aws, this.state.region);

    await removeAllRoles(this, clients);

    console.log(`Removing lambda ${this.state.name} from the ${this.state.region} region.`)
    await deleteLambdaFunction(clients.lambda, this.state.name)
    console.log(`Successfully removed lambda ${this.state.name} from the ${this.state.region} region.`)

    this.state = {}
    return {}
  }

  /**
   * Metrics
   */
  async metrics(inputs = {}) {
    // Validate
    if (!inputs.rangeStart || !inputs.rangeEnd) {
      throw new Error('rangeStart and rangeEnd are require inputs');
    }

    const result = await getMetrics(
      this.state.region,
      this.state.metaRoleArn,
      this.state.name,
      inputs.rangeStart,
      inputs.rangeEnd
    );

    return result;
  }
}

/**
 * Exports
 */
module.exports = AwsLambda
