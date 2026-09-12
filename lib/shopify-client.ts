/**
 * Shopify Admin GraphQL client
 *
 * Thin wrapper around fetch() that handles all GraphQL calls to a specific
 * store. Each store has its own domain + access token (fetched from the
 * database per store).
 */

const API_VERSION = "2026-07";

export type GraphQLResponse<T> = {
  data?: T;
  errors?: { message: string }[];
};

export class ShopifyGraphQLError extends Error {}

export async function shopifyGraphQL<T>(
  storeDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const url = `https://${storeDomain}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new ShopifyGraphQLError(
      `Shopify API returned HTTP ${response.status}. ${bodyText.slice(0, 300)}`
    );
  }

  const json = (await response.json()) as GraphQLResponse<T>;

  if (json.errors && json.errors.length > 0) {
    throw new ShopifyGraphQLError(
      `GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }

  if (!json.data) {
    throw new ShopifyGraphQLError("Shopify returned no data.");
  }

  return json.data;
}
