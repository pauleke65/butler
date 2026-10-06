#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ButlerStack } from "../lib/butler-stack";
import { loadConfig } from "../lib/config";

const app = new App();
const config = loadConfig(app.node);
new ButlerStack(app, `butler-${config.stage}`, config, {
  description: `Butler (${config.stage}): Alexa+ add-on backend - AgentCore Gateway/Policy/Runtime, Lambda, DynamoDB, Cognito`,
});
