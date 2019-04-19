# aws-lambda

Deploy Lambda functions to AWS in seconds with [Serverless Components](https://github.com/serverless/components). Utilizes layers for dependency management and S3 accelerated uploads for maximum upload speeds.

&nbsp;

1. [Install](#1-install)
2. [Create](#2-create)
3. [Configure](#3-configure)
4. [Deploy](#4-deploy)

&nbsp;


### 1. Install

```console
$ npm install -g @serverless/components
```

### 2. Create


```console
$ mkdir my-function && cd my-function
```

the directory should look something like this:


```
|- code
  |- handler.js
  |- package.json # optional
|- serverless.yml
|- .env      # your development AWS api keys
|- .env.prod # your production AWS api keys
```

```js
// handler.js
module.exports.hello = async (event, context, cb) => {
  return { hello: 'world' }
}

```

the `.env` files are not required if you have the aws keys set globally and you want to use a single stage, but they should look like this.

```
AWS_ACCESS_KEY_ID=XXX
AWS_SECRET_ACCESS_KEY=XXX
```


### 3. Configure

```yml
# serverless.yml

name: my-function
stage: dev

myFunction:
  component: "@serverless/aws-lambda"
  inputs:
    name: my-function
    description: My Serverless Function
    memory: 128
    timeout: 20
    code: ./code
    handler: handler.hello
    runtime: nodejs8.10
    env:
      TABLE_NAME: my-table
    region: us-east-1

    # if you'd like to include any shims
    shims:
      - ../shims/shim.js 

    # specifying an existing deployment bucket would optimise deployment speed
    # by using accelerated multipart uploads and dependency management with layers
    bucket: my-deployment-bucket
```

### 4. Deploy

```console
aws-lambda (master)$ components

  AwsLambda › outputs:
  name:  'my-function'
  description:  'My Serverless Function'
  memory:  128
  timeout:  20
  code:  './code'
  bucket:  undefined
  shims:  []
  handler:  'handler.hello'
  runtime:  'nodejs8.10'
  env: 
    TABLE_NAME: my-table
  role: 
    name:  'serverless'
    arn:  'arn:aws:iam::552760238299:role/serverless'
    service:  'lambda.amazonaws.com'
    policy:  { arn: 'arn:aws:iam::aws:policy/AdministratorAccess' }
  arn:  'arn:aws:lambda:us-east-1:552760238299:function:serverless'


  22s › dev › AwsLambda › done

aws-lambda (master)$

```
For a real world example of how this component could be used, [take a look at how the socket component is using it](https://github.com/serverless-components/socket).

&nbsp;

### New to Components?

Checkout the [Serverless Components](https://github.com/serverless/components) repo for more information.
