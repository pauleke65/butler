import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { assetDir } from "../assets";
import type { ButlerConfig } from "../config";

/** Optional fixed clock for a demo stage (`-c butlerNow=2026-10-12T10:00:00-04:00`): makes dates and deliveries repeatable. */
export function demoClock(config: ButlerConfig): Record<string, string> {
  return config.butlerNow ? { BUTLER_NOW: config.butlerNow } : {};
}

export const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;

function pythonFunction(scope: Construct, id: string, config: ButlerConfig, opts: {
  name: string;
  asset: "actions" | "executor" | "debug-api";
  handler: string;
  memorySize: number;
  timeout: Duration;
  environment: Record<string, string>;
  description: string;
}): lambda.Function {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/lambda/${config.prefix}-${opts.name}`,
    retention: LOG_RETENTION,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return new lambda.Function(scope, id, {
    functionName: `${config.prefix}-${opts.name}`,
    description: opts.description,
    runtime: lambda.Runtime.PYTHON_3_12,
    architecture: lambda.Architecture.ARM_64,
    handler: opts.handler,
    code: lambda.Code.fromAsset(assetDir(config, opts.asset)),
    memorySize: opts.memorySize,
    timeout: opts.timeout,
    environment: { STAGE: config.stage, LOG_LEVEL: "INFO", ...opts.environment },
    logGroup,
  });
}

export interface ActionsLambdaProps {
  config: ButlerConfig;
  table: dynamodb.ITable;
  googleSecret: secretsmanager.ISecret;
  paymentSecret: secretsmanager.ISecret;
  /** SES identity addresses the function may send from (the configured SES_FROM_ADDRESS only). */
  sesFromAddress: string;
}

/**
 * ONE function serves all five Gateway targets (Messages, Calendar, Supplies, Services, Context): the entry reads the
 * tool name from `context.client_context.custom["bedrockAgentCoreToolName"]`.
 * Least privilege: its own table access, the Google and payment secrets, SES send FROM the configured identity only.
 */
export class ActionsLambda extends Construct {
  readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ActionsLambdaProps) {
    super(scope, id);
    const { config } = props;
    this.fn = pythonFunction(this, "Function", config, {
      name: "actions",
      asset: "actions",
      handler: "butler_action_handlers.lambda_handler.handler",
      memorySize: 512,
      timeout: Duration.seconds(30),
      description: "Butler Gateway action targets (all five), contracts section 7",
      environment: {
        TABLE_NAME: props.table.tableName,
        ...demoClock(config),
        HOUSEHOLD_ID: config.householdId,
        ADAPTERS: config.adapters,
        // butler_action_handlers.real_adapters reads SES_FROM (not SES_FROM_ADDRESS) and GOOGLE_OAUTH_SECRET_ID.
        SES_FROM: config.sesFromAddress,
        SES_SANDBOX: "true",
        SES_ALLOWED_RECIPIENTS: config.sesRecipients.join(","),
        GOOGLE_OAUTH_SECRET_ID: props.googleSecret.secretArn,
        GOOGLE_CALENDAR_ID: config.googleCalendarId,
        PAYMENT_PROVIDER: config.paymentProvider,
        PAYMENT_SECRET_ARN: props.paymentSecret.secretArn,
        WEATHER_MODE: "live",
      },
    });
    props.table.grantReadWriteData(this.fn);
    props.googleSecret.grantRead(this.fn);
    props.paymentSecret.grantRead(this.fn);
    const stack = Stack.of(this);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "SendEmailFromConfiguredIdentityOnly",
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [`arn:${stack.partition}:ses:${config.region}:${config.account}:identity/${props.sesFromAddress}`],
        conditions: { StringEquals: { "ses:FromAddress": props.sesFromAddress } },
      }),
    );
  }
}

export interface ExecutorLambdaProps {
  config: ButlerConfig;
  table: dynamodb.ITable;
  executorSecret: secretsmanager.ISecret;
  env: Record<string, string>;
}

/** The approval executor: deterministic, reads ONLY the executor client secret. */
export class ExecutorLambda extends Construct {
  readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ExecutorLambdaProps) {
    super(scope, id);
    const { config } = props;
    this.fn = pythonFunction(this, "Function", config, {
      name: "approval-executor",
      asset: "executor",
      handler: "butler_executor.lambda_handler.handler",
      memorySize: 512,
      timeout: Duration.seconds(30),
      description: "Butler approval executor (contracts section 6)",
      environment: {
        TABLE_NAME: props.table.tableName,
        ...demoClock(config),
        HOUSEHOLD_ID: config.householdId,
        EXECUTOR_CLIENT_SECRET_ARN: props.executorSecret.secretArn,
        ...props.env,
      },
    });
    props.table.grantReadWriteData(this.fn);
    props.executorSecret.grantRead(this.fn);
  }
}

export interface DebugApiProps {
  config: ButlerConfig;
  table: dynamodb.ITable;
  token: string;
}

/** Black Box debug API: read-only table access; Function URL with a static bearer token (dev/demo only). */
export class DebugApi extends Construct {
  readonly fn: lambda.Function;
  readonly url: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: DebugApiProps) {
    super(scope, id);
    const { config } = props;
    this.fn = pythonFunction(this, "Function", config, {
      name: "debug-api",
      asset: "debug-api",
      handler: "debug_api.core.lambda_handler",
      memorySize: 256,
      timeout: Duration.seconds(10),
      description: "Butler debug API for the Black Box panel (contracts section 11), read-only",
      environment: {
        TABLE_NAME: props.table.tableName,
        ...demoClock(config),
        DEBUG_HOUSEHOLD_ID: config.householdId,
        DEBUG_API_TOKEN: props.token,
      },
    });
    props.table.grantReadData(this.fn);
    this.url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
