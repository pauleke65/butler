import { Annotations } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ses from "aws-cdk-lib/aws-ses";
import { Construct } from "constructs";
import type { ButlerConfig } from "../config";

/** SES identities. NOTE: creating an email identity sends a verification mail; someone has to click the link.
 * With the @example.com placeholder no identity is created (nothing to verify, nothing sent); use fake adapters. */
export class SesIdentities extends Construct {
  readonly from?: ses.EmailIdentity;
  readonly recipients: ses.EmailIdentity[];

  constructor(scope: Construct, id: string, config: ButlerConfig) {
    super(scope, id);
    const placeholder = config.sesFromAddress.endsWith("@example.com");
    if (placeholder) {
      Annotations.of(this).addWarning(
        "SES_FROM_ADDRESS is the @example.com placeholder: no SES identity created. Pass `-c SES_FROM_ADDRESS=you@yourdomain` for real email.",
      );
    } else {
      this.from = new ses.EmailIdentity(this, "From", { identity: ses.Identity.email(config.sesFromAddress) });
    }
    this.recipients = placeholder
      ? []
      : config.sesRecipients
          .filter((a) => a !== config.sesFromAddress)
          .map((address, i) => new ses.EmailIdentity(this, `Recipient${i}`, { identity: ses.Identity.email(address) }));
  }
}

/**
 * One monthly cost budget of $100 with notifications at $50 (50%) and $100 (100%) of actual spend (handoff README
 * section 5). Account-wide: Budgets cannot be scoped to this stack without cost-allocation tags.
 */
export class CostBudget extends Construct {
  constructor(scope: Construct, id: string, config: ButlerConfig) {
    super(scope, id);
    if (!config.budgetEmail) {
      Annotations.of(this).addWarning("No budget created: pass `-c budgetEmail=you@example.com` to get the $50 / $100 alarms.");
      return;
    }
    const subscribers = [{ subscriptionType: "EMAIL", address: config.budgetEmail }];
    const notification = (threshold: number): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
      subscribers,
    });
    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: `${config.prefix}-monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: 100, unit: "USD" },
      },
      // 50% of $100 = $50 and 100% = $100
      notificationsWithSubscribers: [notification(50), notification(100)],
    });
  }
}

/** Saved CloudWatch Logs Insights queries (ticket P-7). */
export class SavedQueries extends Construct {
  constructor(scope: Construct, id: string, config: ButlerConfig, logGroupNames: string[]) {
    super(scope, id);
    const q = (name: string, queryString: string): void => {
      new logs.CfnQueryDefinition(this, name.replace(/\W/g, ""), {
        name: `${config.prefix}/${name}`,
        queryString,
        logGroupNames,
      });
    };
    q("trace a correlation_id", [
      "fields @timestamp, @log, @message",
      "| filter @message like /REPLACE_WITH_CORRELATION_ID/",
      "| sort @timestamp asc",
      "| limit 200",
    ].join("\n"));
    q("all DENYs today", [
      "fields @timestamp, @log, @message",
      "| filter @message like /denied|DENY|POLICY_DENIED/",
      "| sort @timestamp desc",
      "| limit 100",
    ].join("\n"));
    q("parity mismatches", [
      "fields @timestamp, @log, @message",
      "| filter @message like /PARITY_MISMATCH/",
      "| sort @timestamp desc",
      "| limit 100",
    ].join("\n"));
  }
}
