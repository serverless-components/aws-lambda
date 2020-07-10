const https = require('https');
const AWS = require('@serverless/aws-sdk-extra')
const { equals, not, pick } = require('ramda')
const { readFile } = require('fs-extra')

const agent = new https.Agent({
  keepAlive: true,
});

/**
 * Sleep
 * @param {*} wait
 */
const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait))

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
const getClients = (credentials = {}, region) => {
  AWS.config.update({
    httpOptions: {
      agent,
    },
  });

  const extras = new AWS.Extras({ credentials, region })
  const iam = new AWS.IAM({ credentials, region })
  const lambda = new AWS.Lambda({ credentials, region })
  const sts = new AWS.STS({ credentials, region })
  return { iam, lambda, extras, sts }
}

/**
 * Prepare inputs
 * @param {*} inputs
 * @param {*} instance
 */
const prepareInputs = (inputs, instance) => {

  return {
    name:
      inputs.name || instance.state.name || `${instance.name}-${instance.stage}-${randomId}`,
    roleName: inputs.roleName,
    description: inputs.description || `An AWS Lambda function from the AWS Lambda Serverless Framework Component.  Name: "${instance.name}" Stage: "${instance.stage}"`,
    memory: inputs.memory || 1028,
    timeout: inputs.timeout || 10,
    src: inputs.src || null,
    handler: inputs.handler || 'handler.handler',
    runtime: 'nodejs12.x',
    env: inputs.env || {},
    region: inputs.region || 'us-east-1',
    layers: inputs.layers || [],
    securityGroupIds: inputs.vpcConfig ? inputs.vpcConfig.securityGroupIds : false,
    subnetIds: inputs.vpcConfig ? inputs.vpcConfig.subnetIds : false
  }
}

/*
 * Ensure the provided IAM Role or default IAM Role exists
 *
 * @param ${instance} instance - the component instance
 * @param ${object} inputs - the component inputs
 * @param ${object} clients - the aws clients object
 */
const createOrUpdateFunctionRole = async (instance, inputs, clients) => {
  // Verify existing role, either provided or the previously created default role...
  if (inputs.roleName) {
    console.log(
      `Verifying the provided IAM Role with the name: ${inputs.roleName} in the inputs exists...`
    );

    const userRole = await clients.extras.getRole({ roleName: inputs.roleName });
    const userRoleArn = userRole && userRole.Role && userRole.Role.Arn ? userRole.Role.Arn : null; // Don't save user provided role to state, always reference it as an input, in case it changes

    // If user role exists, save it to state so it can be used for the create/update lambda logic later
    if (userRoleArn) {
      console.log(`The provided IAM Role with the name: ${inputs.roleName} in the inputs exists.`);
      instance.state.userRoleArn = userRoleArn;

      // Save AWS Account ID by fetching the role ID
      // TODO: This may not work with cross-account roles.
      instance.state.awsAccountId = instance.state.userRoleArn.split(':')[4];

      // Be sure to delete defaultLambdaRoleArn data, if it exists
      if (instance.state.defaultLambdaRoleArn) {
        delete instance.state.defaultLambdaRoleArn
      }
    } else {
      throw new Error(
        `The provided IAM Role with the name: ${inputs.roleName} could not be found.`
      );
    }
  } else {
    // Create a default role with basic Lambda permissions

    const defaultLambdaRoleName = `${inputs.name}-lambda-role`;
    console.log(
      `IAM Role not found.  Creating or updating a default role with the name: ${defaultLambdaRoleName}`
    );

    const result = await clients.extras.deployRole({
      roleName: defaultLambdaRoleName,
      service: ['lambda.amazonaws.com'],
      policy: 'arn:aws:iam::aws:policy/AWSLambdaFullAccess',
    });

    instance.state.defaultLambdaRoleName = defaultLambdaRoleName;
    instance.state.defaultLambdaRoleArn = result.roleArn;
    instance.state.awsAccountId = instance.state.defaultLambdaRoleArn.split(':')[4];

    // Be sure to delete userRole data, if it exists
    if (instance.state.userRoleArn) {
      delete instance.state.userRoleArn
    }

    console.log(
      `Default Lambda IAM Role created or updated with ARN ${instance.state.defaultLambdaRoleArn}`
    );
  }
};

/*
 * Ensure the Meta IAM Role exists
 */
const createOrUpdateMetaRole = async (instance, inputs, clients, serverlessAccountId) => {
  // Create or update Meta Role for monitoring and more, if option is enabled.  It's enabled by default.
  if (inputs.monitoring || typeof inputs.monitoring === 'undefined') {
    console.log('Creating or updating the meta IAM Role...');

    const roleName = `${instance.name}-meta-role`;

    const assumeRolePolicyDocument = {
      Version: '2012-10-17',
      Statement: {
        Effect: 'Allow',
        Principal: {
          AWS: `arn:aws:iam::${serverlessAccountId}:root`, // Serverless's Components account
        },
        Action: 'sts:AssumeRole',
      },
    };

    // Create a policy that only can access APIGateway and Lambda metrics, logs from CloudWatch...
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Resource: '*',
          Action: [
            'cloudwatch:Describe*',
            'cloudwatch:Get*',
            'cloudwatch:List*',
            'logs:Get*',
            'logs:List*',
            'logs:Describe*',
            'logs:TestMetricFilter',
            'logs:FilterLogEvents',
          ],
          // TODO: Finish this.  Haven't been able to get this to work.  Perhaps there is a missing service (Cloudfront?)
          // Condition: {
          //   StringEquals: {
          //     'cloudwatch:namespace': [
          //       'AWS/ApiGateway',
          //       'AWS/Lambda'
          //     ]
          //   }
          // }
        },
      ],
    };

    const roleDescription = `The Meta Role for the Serverless Framework App: ${instance.name} Stage: ${instance.stage}`;

    const result = await clients.extras.deployRole({
      roleName,
      roleDescription,
      policy,
      assumeRolePolicyDocument,
    });

    instance.state.metaRoleName = roleName;
    instance.state.metaRoleArn = result.roleArn;

    console.log(`Meta IAM Role created or updated with ARN ${instance.state.metaRoleArn}`);
  }
};

/**
 * Create a new lambda function
 * @param {*} lambda
 * @param {*} config
 */
const createLambdaFunction = async (instance, lambda, inputs) => {
  const params = {
    FunctionName: inputs.name,
    Code: {},
    Description: inputs.description,
    Handler: inputs.handler,
    MemorySize: inputs.memory,
    Publish: true,
    Role: instance.state.userRoleArn || instance.state.defaultLambdaRoleArn,
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
      return await createLambdaFunction(instance, lambda, inputs)
    }
    throw e
  }
}

/**
 * Update Lambda configuration
 * @param {*} lambda
 * @param {*} config
 */
const updateLambdaFunctionConfig = async (instance, lambda, inputs) => {
  const functionConfigParams = {
    FunctionName: inputs.name,
    Description: inputs.description,
    Handler: inputs.handler,
    MemorySize: inputs.memory,
    Role: instance.state.userRoleArn || instance.state.defaultLambdaRoleArn,
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

/*
 * Removes the Function & Meta Roles from aws according to the provided config
 *
 * @param ${object} clients - an object containing aws sdk clients
 * @param ${object} config - the component config
 */
const removeAllRoles = async (instance, clients) => {
  // Delete Function Role
  if (instance.state.defaultLambdaRoleName) {
    console.log('Deleting the default Function Role...');
    await clients.extras.removeRole({
      roleName: instance.state.defaultLambdaRoleName,
    });
  }

  // Delete Meta Role
  if (instance.state.metaRoleName) {
    console.log('Deleting the Meta Role...');
    await clients.extras.removeRole({
      roleName: instance.state.metaRoleName,
    });
  }
};


/**
 * Get metrics from cloudwatch
 * @param {*} clients
 * @param {*} rangeStart MUST be a moment() object
 * @param {*} rangeEnd MUST be a moment() object
 */
const getMetrics = async (
  region,
  metaRoleArn,
  functionName,
  rangeStart,
  rangeEnd
) => {
  /**
   * Create AWS STS Token via the meta role that is deployed with the Express Component
   */

  // Assume Role
  const assumeParams = {};
  assumeParams.RoleSessionName = `session${Date.now()}`;
  assumeParams.RoleArn = metaRoleArn;
  assumeParams.DurationSeconds = 900;

  const sts = new AWS.STS({ region })
  const resAssume = await sts.assumeRole(assumeParams).promise();

  const roleCreds = {};
  roleCreds.accessKeyId = resAssume.Credentials.AccessKeyId;
  roleCreds.secretAccessKey = resAssume.Credentials.SecretAccessKey;
  roleCreds.sessionToken = resAssume.Credentials.SessionToken;

  /**
   * Instantiate a new Extras instance w/ the temporary credentials
   */

  const extras = new AWS.Extras({
    credentials: roleCreds,
    region,
  })

  const resources = [
    {
      type: 'aws_lambda',
      functionName,
    },
  ];

  return await extras.getMetrics({
    rangeStart,
    rangeEnd,
    resources,
  });
};

/**
 * Exports
 */
module.exports = {
  prepareInputs,
  getClients,
  createOrUpdateFunctionRole,
  createOrUpdateMetaRole,
  createLambdaFunction,
  updateLambdaFunctionCode,
  updateLambdaFunctionConfig,
  getLambdaFunction,
  inputsChanged,
  deleteLambdaFunction,
  removeAllRoles,
  getMetrics,
}
