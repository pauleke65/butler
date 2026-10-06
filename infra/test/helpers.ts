import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ButlerStack } from "../lib/butler-stack";
import { loadConfig } from "../lib/config";

export interface Synth {
  stack: ButlerStack;
  template: Template;
  json: CfnTemplate;
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, any>;
  Metadata?: { "aws:cdk:path"?: string };
  DependsOn?: string[] | string;
}
export interface CfnTemplate {
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, { Value: unknown; Description?: string }>;
}

/** Synthesize the stack offline (dummy account, stub assets so no `infra/dist` is needed). */
export function synth(context: Record<string, string> = {}): Synth {
  const app = new App({
    context: {
      "aws:cdk:enable-path-metadata": true,
      account: "000000000000",
      stubAssets: "true",
      budgetEmail: "budget@example.org",
      SES_FROM_ADDRESS: "butler@example.org",
      sesRecipients: "tester@example.org",
      ...context,
    },
  });
  const config = loadConfig(app.node);
  const stack = new ButlerStack(app, `butler-${config.stage}`, config);
  const template = Template.fromStack(stack);
  return { stack, template, json: template.toJSON() as CfnTemplate };
}

export function resourcesOfType(json: CfnTemplate, type: string): Array<[string, CfnResource]> {
  return Object.entries(json.Resources).filter(([, r]) => r.Type === type);
}

/** Logical id of the one resource whose construct path ends with `suffix`. */
export function idByPath(json: CfnTemplate, suffix: string): string {
  const hits = Object.entries(json.Resources).filter(([, r]) => r.Metadata?.["aws:cdk:path"]?.endsWith(suffix));
  if (hits.length !== 1) throw new Error(`expected exactly one resource at "${suffix}", found ${hits.length}`);
  return hits[0]![0];
}

export interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

/** Every IAM statement attached to the role with this logical id (inline policies of AWS::IAM::Policy). */
export function statementsOfRole(json: CfnTemplate, roleLogicalId: string): Statement[] {
  const out: Statement[] = [];
  for (const [, res] of resourcesOfType(json, "AWS::IAM::Policy")) {
    const roles = (res.Properties?.["Roles"] ?? []) as Array<{ Ref?: string }>;
    if (roles.some((r) => r.Ref === roleLogicalId)) out.push(...(res.Properties!["PolicyDocument"].Statement as Statement[]));
  }
  return out;
}

export function actionsOf(st: Statement): string[] {
  return Array.isArray(st.Action) ? st.Action : [st.Action];
}

export function resourcesOf(st: Statement): unknown[] {
  return Array.isArray(st.Resource) ? st.Resource : [st.Resource];
}

/** Logical ids of the secrets a role can read (secretsmanager:GetSecretValue). */
export function readableSecrets(json: CfnTemplate, roleLogicalId: string): string[] {
  const ids: string[] = [];
  for (const st of statementsOfRole(json, roleLogicalId)) {
    if (!actionsOf(st).includes("secretsmanager:GetSecretValue")) continue;
    for (const r of resourcesOf(st)) ids.push(typeof r === "object" && r !== null && "Ref" in r ? String((r as { Ref: string }).Ref) : JSON.stringify(r));
  }
  return ids;
}
