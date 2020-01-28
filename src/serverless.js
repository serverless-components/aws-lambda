const { Component } = require('@serverless/core')
const { publishLayer, createLayerBucket } = require('./utils')

class AwsLambdaLayer extends Component {
  async deploy(inputs = {}) {

    inputs.region = inputs.region || 'us-east-1'
    inputs.name = inputs.name || 'layer-component'
    inputs.runtimes = inputs.runtimes || []

    // Detect bucket
    if (!this.state.bucketName) {
      console.log('Creating a layer bucket')
      const bucket = await createLayerBucket(this.credentials.aws, inputs.region)
      console.log('Created: ', bucket)
      this.state.bucketName = bucket
    }

    this.state.region = inputs.region || this.state.region || 'us-east-1'
    this.state.name = inputs.name || this.state.name || 'layer-component-' + Math.random().toString(36).substring(7)

    const res = await publishLayer(this.credentials.aws, inputs.region, inputs.src, this.state.name, this.state.bucketName, inputs.runtimes)
    
    this.state.arn = res.LayerArn
    this.state.arnVersion = res.LayerVersionArn

    return {
      name: this.state.name,
      region: this.state.region,
      arn: this.state.arn,
      arnVersion: this.state.arnVersion,
      bucketName: this.state.bucketName,
    }
  }

  async remove() {
    return {}
  }

  extract() {
    return false
  }
}

module.exports = AwsLambdaLayer
