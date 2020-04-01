const path = require('path')
const { generateId, getCredentials, getServerlessSdk, getLambda, invokeLambda } = require('./utils')

// set enough timeout for deployment to finish
jest.setTimeout(30000)

// the yaml file we're testing against
const instanceYaml = {
  org: 'serverlessinc',
  app: 'myApp',
  component: 'aws-lambda@dev',
  name: `aws-lambda-integration-tests-${generateId()}`,
  stage: 'dev',
  inputs: {} // should deploy with zero inputs
}

// we need to keep the initial instance state after first deployment
// to validate removal later
let firstInstanceState

// get aws credentials from env
const credentials = getCredentials()

// get serverless access key from env and construct sdk
const sdk = getServerlessSdk(instanceYaml.org)

// clean up the instance after tests
afterAll(async () => {
  await sdk.remove(instanceYaml, credentials)
})

it('should successfully deploy lambda function', async () => {
  const instance = await sdk.deploy(instanceYaml, credentials)

  // store the inital state for removal validation later on
  firstInstanceState = instance.state

  expect(instance.outputs.name).toBeDefined()
  expect(instance.outputs.arn).toBeDefined()
})

it('should successfully update basic configuration', async () => {
  instanceYaml.inputs.memory = 3008
  instanceYaml.inputs.timeout = 30

  const instance = await sdk.deploy(instanceYaml, credentials)

  const lambda = await getLambda(credentials, instance.state.name)

  expect(lambda.MemorySize).toEqual(instanceYaml.inputs.memory)
  expect(lambda.Timeout).toEqual(instanceYaml.inputs.timeout)
})

it('should successfully update source code', async () => {
  // first deployment we did not specify source
  // we're now specifying our own source
  instanceYaml.inputs.src = path.resolve(__dirname, 'src')

  const instance = await sdk.deploy(instanceYaml, credentials)

  const response = await invokeLambda(credentials, instance.state.name)

  expect(response).toEqual('success')
})

it('should successfully remove lambda', async () => {
  await sdk.remove(instanceYaml, credentials)

  // make sure lambda was actually removed
  let lambda
  try {
    lambda = await getLambda(credentials, firstInstanceState.name)
  } catch (e) {
    if (e.code !== 'ResourceNotFoundException') {
      throw e
    }
  }

  expect(lambda).toBeUndefined()
})
