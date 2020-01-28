const AWS = require('aws-sdk')
const path = require('path')
const shortid = require('shortid')
const { readFileSync, readdirSync, removeSync } = require('fs-extra')

const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait))

/**
 * Create Layer Bucket
 */
const createLayerBucket = async(credentials, region) => {
  const s3 = new AWS.S3({ credentials, region })
  const Bucket = 'layer-code-' + Math.random().toString(36).substring(7) // TODO: Not long enough.  Collision risk.
  const params = {
    Bucket,
    ACL: 'private',
  }
  await s3.createBucket(params).promise()
  return Bucket
}

const publishLayer = async (credentials, region, zipPath, layerName, bucketName, runtimes = []) => {
  const s3 = new AWS.S3({ credentials, region })
  const lambda = new AWS.Lambda({ credentials, region })

  const keyName = `layer-${Date.now()}`

  var params = { 
    Bucket: bucketName, 
    Key: keyName, 
    Body: readFileSync(zipPath)
  }
  var options = { partSize: 10 * 1024 * 1024, queueSize: 1 }
  const upload = await s3.upload(params, options).promise()

  const layerParams = {
    Content: {
      S3Bucket: bucketName,
      S3Key: upload.Key,
    },
    LayerName: layerName, /* required */
    CompatibleRuntimes: runtimes
  }
  const res = await lambda.publishLayerVersion(layerParams).promise()

  // Clean up the zip
  removeSync(zipPath)

  return res
}

module.exports = {
  createLayerBucket,
  publishLayer,
  sleep,
}
