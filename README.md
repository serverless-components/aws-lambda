# AwsLambda
A serverless component that provisions a Lambda function with optimized package and deployment speed.

## Usage

### Declarative

```yml

name: my-aws-lambda
stage: dev

AwsLambda@0.1.3::aws-lambda:
  name: my-func
  description: My Serverless Function
  memory: 128
  timeout: 20
  code: ./code
  handler: handler.hello
  runtime: nodejs8.10
  env:
    TABLE_NAME: my-table
  regoin: us-east-1
  
  # if you'd like to include any shims
  shims:
    - ../shims/shim.js 
  
  # specifying a deployment bucket would optimise deployment speed
  # by using accelerated multipart uploads and dependency management with layers
  bucket: my-deployment-bucket
```

### Programatic

```js
npm i --save @serverless/aws-lambda
```

```js

const lambda = await this.load('@serverless/aws-lambda')

const inputs = {
  name: 'my-func',
  description: 'My Serverless Function',
  memory: 512,
  timeout: 10,
  code: './code',
  bucket: 'my-deployment-bucket',
  shims: [],
  handler: 'handler.hello',
  runtime: 'nodejs8.10',
  env: {},
  region: 'us-east-1'
}

await lambda(inputs)

```
