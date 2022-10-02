import { getInput, getBooleanInput, setOutput, setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import shellac from "shellac";
import { fetch } from "undici";

// TODO: Confirm types

interface Stage {
  name: string;
  started_on: null | string;
  ended_on: null | string;
  status: string;
}

interface Deployment {
  id: string;
  short_id: string;
  project_id: string;
  project_name: string;
  environment: string;
  url: string;
  created_on: string;
  modified_on: string;
  latest_stage: Stage;
  deployment_trigger: {
    type: string;
    metadata: {
      branch: string;
      commit_hash: string;
      commit_message: string;
      commit_dirty: boolean;
    };
  };
  stages: Stage[];
  build_config: {
    build_command: null | string;
    destination_dir: null | string;
    root_dir: null | string;
    web_analytics_tag: null | string;
    web_analytics_token: null | string;
    fast_builds: boolean;
  };
  env_vars: unknown;
  kv_namespaces: Record<string, { namespace_id: string }>;
  aliases: null | string[];
  is_skipped: boolean;
  production_branch: string;
}

try {
  const apiToken = getInput("apiToken", { required: true });
  const accountId = getInput("accountId", { required: true });
  const projectName = getInput("projectName", { required: true });
  const directory = getInput("directory", { required: true });
  const gitHubToken = getInput("gitHubToken", { required: false });
  const branch = getInput("branch", { required: false });
  const skipGitHubDeployment = getBooleanInput("skipGitHubDeployment", {
    required: false,
  });

  // TODO: clean this up a bit
  let octokit;

  const _getOctokit = () => {
    if (gitHubToken && !octokit) {
      octokit = getOctokit(gitHubToken);
    }
    return octokit;
  };

  const createPagesDeployment = async () => {
    // TODO: Replace this with an API call to wrangler so we can get back a full deployment response object
    await shellac`
    $ export CLOUDFLARE_API_TOKEN="${apiToken}"
    if ${accountId} {
      $ export CLOUDFLARE_ACCOUNT_ID="${accountId}"
    }
  
    $$ npx wrangler@2 pages publish "${directory}" --project-name="${projectName}" --branch="${branch}"
    `;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    const {
      result: [deployment],
    } = (await response.json()) as { result: Deployment[] };

    return deployment;
  };

  const createGitHubDeployment = async () => {
    const _octokit = _getOctokit();

    const deployment = await _octokit.rest.repos.createDeployment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: context.ref,
      auto_merge: false,
      description: "Cloudflare Pages",
      required_contexts: [],
    });

    if (deployment.status === 201) {
      return deployment.data;
    }
  };

  const createGitHubDeploymentStatus = async ({
    id,
    url,
    environmentName,
    productionEnvironment,
  }: {
    id: number;
    url: string;
    environmentName: string;
    productionEnvironment: boolean;
  }) => {
    const _octokit = _getOctokit();

    await _octokit.rest.repos.createDeploymentStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      deployment_id: id,
      // @ts-ignore
      environment: environmentName,
      environment_url: url,
      production_environment: productionEnvironment,
      log_url: `https://dash.cloudflare.com/${accountId}/pages/view/${projectName}/${id}`,
      description: "Cloudflare Pages",
      state: "success",
    });
  };

  (async () => {
    let gitHubDeployment: Record<string, any> | undefined;

    if (!skipGitHubDeployment) {
      gitHubDeployment = await createGitHubDeployment();
    }

    const pagesDeployment = await createPagesDeployment();

    setOutput("id", pagesDeployment.id);
    setOutput("url", pagesDeployment.url);
    setOutput("environment", pagesDeployment.environment);

    const url = new URL(pagesDeployment.url);
    const productionEnvironment = pagesDeployment.environment === "production";
    const environmentName = productionEnvironment
      ? "Production"
      : `Preview (${url.host.split(".")[0]})`;

    if (gitHubDeployment) {
      await createGitHubDeploymentStatus({
        id: gitHubDeployment.id,
        url: pagesDeployment.url,
        environmentName,
        productionEnvironment,
      });
    }
  })();
} catch (thrown) {
  setFailed(thrown.message);
}
