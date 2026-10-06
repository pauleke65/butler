/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // views are iframes with side effects; double-mount makes timings misleading
  serverExternalPackages: ["@aws-sdk/client-bedrock-runtime", "@aws-sdk/client-polly"],
  devIndicators: false,
  agentRules: false,
};
export default nextConfig;
