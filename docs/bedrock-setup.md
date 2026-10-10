# Setting up Amazon Bedrock for Butler (simple guide)

## Why you need this

Butler has a few "thinking" steps:
- turning "six friends are coming Friday" into a plan;
- turning "don't buy drinks without asking me" into a rule;
- a quick first guess at what a situation needs.

These steps can use an AI model from **Amazon Bedrock**. We picked Amazon's own model, **Amazon Nova 2 Lite**.

Right now Butler runs these steps with a **built-in script** instead ("offline mode"). It works well for the demo situations, but it can't handle new situations it hasn't been written for. With Bedrock turned on, Butler can handle situations nobody scripted. It also makes the "AWS Builder" part of your entry stronger.

**The problem:** your AWS account is new, and AWS has set its Bedrock limit to **zero**. Every call to an Amazon model is refused with "Too many tokens per day". The normal limit is 8 million tokens per minute; yours shows 0. The quota page can't fix this; only AWS Support can.

## Steps (about 10 minutes of your time, then wait 1–3 days)

1. Sign in to the AWS console, in the account Butler is deployed to. In the top right, set the region to **US East (N. Virginia) us-east-1**.
2. In the search bar, type **Support Center** and open it.
3. Click **Create case**.
4. Choose **Looking for service quota increases?** (or **Service limit increase**). If you only see "Account and billing", pick that; it's free.
5. Fill in:
   - **Service:** Amazon Bedrock
   - **Region:** US East (N. Virginia)
   - **Quota:** Cross-region model inference tokens per minute for Amazon Nova 2 Lite
   - **New value:** 200000
6. In the description box, paste this:

   > Account <your account id>. Amazon Bedrock quotas for Amazon Nova models show an applied value of 0 (for example L-C6F5908D and L-210172B5 for Nova 2 Lite), while the AWS default is 8,000,000 tokens per minute. Every Converse call fails with "Too many tokens per day". Please restore the default quotas in us-east-1. Use: building an Alexa+ add-on for the Amazon Developer Hackathon, low volume (under 1 million tokens per day).

7. Click **Submit**. AWS emails you when they reply, usually within 1–3 days.
8. While you wait, open **Amazon Bedrock** in the console. Go to **Model catalog** (or **Model access**), find **Amazon Nova 2 Lite** and check it says **Access granted**. If it says "Request access", click it.
9. When AWS replies, tell Claude: **"check Bedrock"**. Claude will make one tiny test call (costs less than a cent).
10. If it works, tell Claude: **"switch Butler to Bedrock"**. Claude will:
    - run the planner tests on the real model;
    - redeploy with `-c llmMode=bedrock`;
    - re-check the demo.

## What it costs

Nova 2 Lite is one of Amazon's cheapest models. Testing and the demo should cost cents to a few dollars, which your $250 credit covers.

## If you skip this

Butler still works and the demo still runs, all in offline mode. The Devpost text must then say the AI model steps run as a deterministic script, and that the Bedrock code exists but hasn't run on the live model.
