import { Duration, RemovalPolicy, SecretValue, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { ButlerConfig } from "../config";

export const SCOPE_NAME = "invoke";
export const RESOURCE_SERVER_ID = "butler";
/** Full OAuth scope, as it appears in the token: `butler/invoke`. */
export const FULL_SCOPE = `${RESOURCE_SERVER_ID}/${SCOPE_NAME}`;

/**
 * Cognito user pool for machine-to-machine auth (client-credentials) plus the Secrets Manager entries.
 *
 *  sim-client         the simulator / Alexa side -> MCP server runtime (JWT authorizer)
 *  butler-agent       the LLM agent -> Gateway   (Cedar principal tag sub = this client id, D9)
 *  approval-executor  the deterministic executor -> Gateway (the other Cedar principal)
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly resourceServer: cognito.UserPoolResourceServer;
  readonly domain: cognito.UserPoolDomain;
  readonly simClient: cognito.UserPoolClient;
  readonly agentClient: cognito.UserPoolClient;
  readonly executorClient: cognito.UserPoolClient;
  readonly agentSecret: secretsmanager.Secret;
  readonly executorSecret: secretsmanager.Secret;
  readonly simSecret: secretsmanager.Secret;
  readonly googleSecret: secretsmanager.Secret;
  readonly paymentSecret: secretsmanager.Secret;
  readonly tokenUrl: string;
  readonly discoveryUrl: string;
  readonly scope = FULL_SCOPE;

  constructor(scope: Construct, id: string, config: ButlerConfig) {
    super(scope, id);
    const stack = Stack.of(this);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: config.prefix,
      selfSignUpEnabled: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.resourceServer = this.userPool.addResourceServer("ResourceServer", {
      identifier: RESOURCE_SERVER_ID,
      userPoolResourceServerName: `${config.prefix}-api`,
      scopes: [{ scopeName: SCOPE_NAME, scopeDescription: "Call Butler services" }],
    });
    const oauthScope = cognito.OAuthScope.resourceServer(this.resourceServer, {
      scopeName: SCOPE_NAME,
      scopeDescription: "Call Butler services",
    });

    // Prefix: lower-case letters, digits, hyphens; must be unique per region (the account id makes it so).
    this.domain = this.userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `${config.prefix}-${config.account}` },
    });

    const mkClient = (name: string): cognito.UserPoolClient =>
      this.userPool.addClient(name, {
        userPoolClientName: name,
        generateSecret: true,
        authFlows: {},
        oAuth: { flows: { clientCredentials: true }, scopes: [oauthScope] },
        accessTokenValidity: Duration.minutes(60),
        preventUserExistenceErrors: true,
      });
    this.simClient = mkClient("sim-client");
    this.agentClient = mkClient("butler-agent");
    this.executorClient = mkClient("approval-executor");

    const clientSecret = (name: string, client: cognito.UserPoolClient): secretsmanager.Secret =>
      new secretsmanager.Secret(this, `${name}Secret`, {
        secretName: `butler/${config.stage}/${name}`,
        description: `Cognito client secret of ${client.node.id} (plain string)`,
        secretStringValue: client.userPoolClientSecret,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    this.agentSecret = clientSecret("agent-client", this.agentClient);
    this.executorSecret = clientSecret("executor-client", this.executorClient);
    this.simSecret = clientSecret("sim-client", this.simClient);

    // Placeholders: filled in by hand after the first deploy (infra/README.md "Manual one-time steps").
    // CloudFormation only writes these on creation, so a later deploy will not overwrite the real values.
    this.googleSecret = new secretsmanager.Secret(this, "GoogleSecret", {
      secretName: `butler/${config.stage}/google-refresh-token`,
      description: "PLACEHOLDER. JSON {client_id, client_secret, refresh_token} of the demo Google account (S-6 script)",
      secretStringValue: secretsPlaceholder({ client_id: "REPLACE_ME", client_secret: "REPLACE_ME", refresh_token: "REPLACE_ME" }),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.paymentSecret = new secretsmanager.Secret(this, "PaymentSecret", {
      secretName: `butler/${config.stage}/payment-key`,
      description: "PLACEHOLDER. Payment provider TEST secret key (sk_test_... for Stripe, or Paystack sk_test_...)",
      secretStringValue: secretsPlaceholder("REPLACE_ME"),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.tokenUrl = `${this.domain.baseUrl()}/oauth2/token`;
    this.discoveryUrl = `https://cognito-idp.${config.region}.${stack.urlSuffix}/${this.userPool.userPoolId}/.well-known/openid-configuration`;
  }
}

function secretsPlaceholder(value: string | Record<string, string>): SecretValue {
  // Not a secret: a visible marker the operator must replace. (CDK flags plaintext secrets on purpose.)
  return SecretValue.unsafePlainText(typeof value === "string" ? value : JSON.stringify(value));
}
