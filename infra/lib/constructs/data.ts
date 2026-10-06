import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import type { ButlerConfig } from "../config";

/**
 * Single table `butler-{stage}` exactly as contracts section 10 / libs/butler_actions store.create_table:
 * PK/SK strings, GSI1 (GSI1PK/GSI1SK, ALL), TTL attribute `ttl`, PITR, on-demand, stream NEW_IMAGE.
 */
export class DataTable extends Construct {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, config: ButlerConfig) {
    super(scope, id);
    this.table = new dynamodb.Table(this, "Table", {
      tableName: config.prefix,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.DESTROY, // dev and demo only (handoff 03: `make destroy STAGE=dev`)
    });
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
