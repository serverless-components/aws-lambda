[![Serverless Components](https://s3.amazonaws.com/public.assets.serverless.com/images/readme_serverless_components.gif)](http://serverless.com)

<br/>

<p align="center">
  <b><a href="https://github.com/serverless-components/aws-lambda/tree/v1">Click Here for Version 1.0</a></b>
</p>

<br/>

**AWS Lambda Component** ⎯⎯⎯ The easiest way to develop & deploy AWS Lambda Functions, powered by [Serverless Components](https://github.com/serverless/components/tree/cloud).

<br/>

- [x] **Zero Configuration** - All we need is your code, then just deploy.
- [x] **Fast Deployments** - Deploy your Lambda functions in seconds.
- [x] **Realtime Cloud Development** - Develop your functions directly on Lambda, with real time logs.
- [x] **Team Collaboration** - Simply share your Lambda arn and other outputs with your team.
- [x] **Built-in Monitoring** - Monitor your Lamdba functions right from the Serverless Dashboard.

<br/>

<img src="/assets/deploy-demo.gif" height="250" align="right">

1. [**Install**](#1-install)
2. [**Initialize**](#2-initialize)
3. [**Deploy**](#3-deploy)
4. [**Configure**](#4-configure)
5. [**Develop**](#5-develop)
6. [**Monitor**](#6-monitor)
7. [**Remove**](#7-remove)

&nbsp;

### 1. Install

To get started with component, install the latest version of the Serverless Framework:

```
$ npm install -g serverless
```

### 2. Initialize

The easiest way to start using the `aws-lambda` component is by initializing the `aws-lambda-starter` template. Just run this command:

```
$ serverless init aws-lambda-starter
$ cd aws-lambda-starter
```

This will also create an empty `.env` file. Open that `.env` file and add in your AWS credentials:

```
# .env
AWS_ACCESS_KEY_ID=XXX
AWS_SECRET_ACCESS_KEY=XXX
```

### 3. Deploy

Once you have the directory set up, you're now ready to deploy. Just run the following command from within the directory containing the `serverless.yml` file:

```
$ serverless deploy
```

Your first deployment might take a little while, but subsequent deployment would just take few seconds. For more information on what's going on during deployment, you could specify the `--debug` flag, which would view deployment logs in realtime:

```
$ serverless deploy --debug
```

### 4. Configure

The `aws-lambda` component is a zero configuration component, meaning that it'll work out of the box with no configuration and sane defaults. With that said, there are still a lot of optional configuration that you can specify.

Here's a complete reference of the `serverless.yml` file for the `aws-lambda` component:

```yml
component: aws-lambda            # (required) name of the component. In that case, it's aws-lambda.
name: my-lambda                  # (required) name of your component instance.
org: serverlessinc               # (optional) serverless dashboard org. default is the first org you created during signup.
app: my-app                      # (optional) serverless dashboard app. default is the same as the name property.
stage: dev                       # (optional) serverless dashboard stage. default is dev.

inputs:
  src: ./src                     # (optional) path to the source folder. default is a hello world function.
  handler: index.handler         # (optional) lambda handler. default is handler.handler.
  memory: 512                    # (optional) lambda memory size.
  timeout: 10                    # (optional) lambda timeout.
  description: My Lambda.        # (optional) lambda description.
  env:                           # (optional) env vars.
    FOO: BAR
  roleName: plain-name           # (optional) custom role name.
  layers:                        # (optional) lambda layers to add to this lambda function. default is an empty array.
    - aws:layer:arn:1
    - aws:layer:arn:2
  vpcConfig:                     # (optional) lambda vpc configuration. default is null.
    securityGroupIds:            # (optional) lambda vpc security group ids.
      - xxx
      - xxx
    subnetIds:                   # (optional) lambda vpc subnet ids.
      - xxx
      - xxx
  region: us-east-2              # (optional) aws region to deploy to. default is us-east-1.
```

Once you've chosen your configuration, run `serverless deploy` again (or simply just `serverless`) to deploy your changes.

### 5. Develop

Now that you've got your basic lambda function up and running, it's time to develop that into a function that you could actual use. Instead of having to run `serverless deploy` everytime you make changes you want to test, you could enable dev mode, which allows the CLI to watch for changes in your source directory as you develop, and deploy instantly on save.

To enable dev mode, just run the following command:

```
$ serverless dev
```

### 6. Monitor

Anytime you need to know more about your running `aws-lambda` instance, you can run the following command to view the most critical info. 

```
$ serverless info
```

This is especially helpful when you want to know the outputs of your instances so that you can reference them in another instance. It also shows you the status of your instance, when it was last deployed, and how many times it was deployed. You will also see a url where you'll be able to view more info about your instance on the Serverless Dashboard.

To digg even deeper, you can pass the `--debug` flag to view the state of your component instance in case the deployment failed for any reason. 

```
$ serverless info --debug
```
### 7. Remove

If you want to tear down your entire `aws-lambda` infrastructure that was created during deployment, just run the following command in the directory containing the `serverless.yml` file. 
```
$ serverless remove
```

The `aws-lambda` component will then use all the data it needs from the built-in state storage system to delete only the relavent cloud resources that it created. Just like deployment, you could also specify a `--debug` flag for realtime logs from the website component running in the cloud.

```
$ serverless remove --debug
```
