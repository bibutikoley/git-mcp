import type { RepoData } from "../../shared/repoData.js";
import {
  constructGitlabUrl,
  fetchFileFromGitLab,
  getRepoBranch,
  searchGitLabRepo,
} from "../utils/gitlab.js"; // Changed from github.js
import { fetchFileWithRobotsTxtCheck } from "../utils/robotsTxt.js";
import htmlToMd from "html-to-md";
// Aliasing searchCode from gitlabClient to avoid naming conflicts if any local searchCode exists
import { searchCode as searchGitLabCode, GitLabEnv } from "../utils/gitlabClient.js"; // Changed from githubClient.js
import { fetchFileFromR2 } from "../utils/r2.js";
import { generateServerName } from "../../shared/nameUtils.js";
import {
  getCachedFetchDocResult,
  cacheFetchDocResult,
} from "../utils/cache.js";

// Define the return type for fetchDocumentation
export type FetchDocumentationResult = {
  fileUsed: string;
  content: { type: "text"; text: string }[];
};

// Add env parameter to access Cloudflare's bindings
export async function fetchDocumentation({
  repoData,
  env,
  ctx,
}: {
  repoData: RepoData;
  env: CloudflareEnvironment & GitLabEnv; // Ensure env type compatibility
  ctx: any;
}): Promise<FetchDocumentationResult> {
  const { owner, repo, urlType } = repoData;
  const cacheTTL = 30 * 60; // 30 minutes in seconds

  // projectId for GitLab is assumed to be owner for now
  const projectId = owner; 

  // Try fetching from cache first
  // Assuming owner and repo are still valid for cache key with GitLab
  if (projectId && repo) {
    const cachedResult = await getCachedFetchDocResult(projectId, repo, env);
    if (cachedResult) {
      console.log(
        `Returning cached fetchDocumentation result for GitLab project ${projectId}/${repo}`,
      );
      return cachedResult;
    }
  }

  // Initialize fileUsed to prevent "used before assigned" error
  let fileUsed = "unknown";
  let content: string | null = null;
  let docsPath: string = "";
  let docsBranch: string = "";
  // let blockedByRobots = false; // Kept for subdomain logic if uncommented

  // Check for subdomain pattern: {subdomain}.gitmcp.io/{path}
  // For now, commenting out subdomain logic as per instructions to focus on GitLab repo functionality.
  /*
  if (urlType === "subdomain") {
    // This logic is specific to GitHub Pages and would need significant changes for GitLab Pages.
    // Map to github.io
    const githubIoDomain = `${owner}.github.io`;
    const pathWithSlash = repo ? `/${repo}` : "";
    const baseURL = `https://${githubIoDomain}${pathWithSlash}/`;

    // Try to fetch llms.txt with robots.txt check
    const llmsResult = await fetchFileWithRobotsTxtCheck(
      baseURL + "llms.txt",
      env,
    );

    if (llmsResult.blockedByRobots) {
      blockedByRobots = true;
      console.log(`Access to ${baseURL}llms.txt disallowed by robots.txt`);
    } else if (llmsResult.content) {
      content = llmsResult.content;
      fileUsed = "llms.txt";
    } else {
      // If llms.txt is not found or disallowed, fall back to the landing page
      console.warn(
        `llms.txt not found or not allowed at ${baseURL}, trying base URL`,
      );
      const indexResult = await fetchFileWithRobotsTxtCheck(baseURL, env);

      if (indexResult.blockedByRobots) {
        blockedByRobots = true;
        console.log(`Access to ${baseURL} disallowed by robots.txt`);
      } else if (indexResult.content) {
        try {
          // Convert HTML to Markdown for proper processing
          content = htmlToMd(indexResult.content);
          fileUsed = "landing page (index.html, converted to Markdown)";
        } catch (error) {
          console.warn(
            `Error converting HTML to Markdown for ${baseURL}: ${error}`,
          );
        }
      }

      // If index page was blocked or not available, try readme.md
      if (!content && !blockedByRobots) {
        const readmeResult = await fetchFileWithRobotsTxtCheck(
          baseURL + "README.md",
          env,
        );

        if (readmeResult.blockedByRobots) {
          blockedByRobots = true;
          console.log(`Access to ${baseURL}README.md disallowed by robots.txt`);
        } else if (readmeResult.content) {
          content = readmeResult.content;
          fileUsed = "README.md";
        }
      }
    }

    // If any path was blocked by robots.txt, return appropriate message
    if (blockedByRobots) {
      content =
        "Access to this GitLab Pages site is restricted by robots.txt. GitMCP respects robots.txt directives."; // Updated to GitLab
      fileUsed = "robots.txt restriction";
    }
  } else */
  // Assuming 'github' urlType now means GitLab repository
  if (urlType === "github" && projectId && repo) {
    // Try static paths + search for llms.txt directly
    // Use projectId for GitLab API calls
    docsBranch = await getRepoBranch(projectId, env); // Get branch once

    console.log(`Checking static paths for llms.txt in GitLab project ${projectId}/${repo}`);
    const possibleLocations = [
      "docs/docs/llms.txt", // Current default
      "llms.txt", // Root directory
      "docs/llms.txt", // Common docs folder
    ];

    // Create array of all location+branch combinations to try
    const fetchPromises = possibleLocations.flatMap((location) => [
      {
        // Using projectId for GitLab
        promise: fetchFileFromGitLab(
          projectId, 
          docsBranch,
          location,
          env,
          // false, // fetchFileFromGitLab doesn't have a 'raw' boolean, it always fetches raw
        ),
        location,
        branch: docsBranch,
      },
    ]);

    // Execute all fetch promises in parallel
    const results = await Promise.all(
      fetchPromises.map(async ({ promise, location, branch }) => {
        const fileContent = await promise; // Renamed content to fileContent to avoid conflict
        return { content: fileContent, location, branch };
      }),
    );

    for (const location of possibleLocations) {
      const mainResult = results.find(
        (r) => r.location === location && r.content !== null,
      );
      if (mainResult) {
        content = mainResult.content;
        fileUsed = `llms.txt`; // Assuming llms.txt is the target

        // Construct GitLab URL. Note: repoData.repo is used for the repo name part of the URL.
        // projectId is used for the API interaction.
        docsPath = constructGitlabUrl(
          projectId,
          mainResult.location, // filePath
          mainResult.branch,
          env, // env might need GITLAB_HOST
        );
        break;
      }
    }

    // Fallback to GitLab Search API if static paths don't work for llms.txt
    if (!content) {
      console.log(
        `llms.txt not found in static paths, trying GitLab Search API for project ${projectId}`,
      );
      // Using projectId for GitLab search
      const result = await searchGitLabRepo(
        projectId,
        "llms.txt", // filename
        env,
        docsBranch, // branch
        // ctx, // searchGitLabRepo doesn't take ctx
      );
      if (result) {
        content = result.content;
        // docsPath should be the URL to the raw file, constructGitlabUrl can be used if path is from result
        // searchGitLabRepo returns { path: string, content: string }
        // The path from searchGitLabRepo is the full path in the repo.
        docsPath = constructGitlabUrl(projectId, result.path, docsBranch, env);
        fileUsed = "llms.txt";
      }
    }

    // Try R2 fallback if llms.txt wasn't found via GitLab
    if (!content) {
      // Try to fetch pre-generated llms.txt using projectId and repo for R2 key
      content = (await fetchFileFromR2(projectId, repo, "llms.txt", env)) ?? null;
      if (content) {
        console.log(`Fetched pre-generated llms.txt for GitLab project ${projectId}/${repo}`);
        fileUsed = "llms.txt (generated)";
      } else {
        console.error(`No pre-generated llms.txt found for GitLab project ${projectId}/${repo}`);
      }
    }

    // Fallback to README if llms.txt not found in any location (GitLab or R2)
    if (!content) {
      console.log(
        `llms.txt not found, trying README.* at root for GitLab project ${projectId}/${repo} on branch ${docsBranch}`,
      );
      // Ensure docsBranch is available (should be fetched above)
      if (!docsBranch) {
        docsBranch = await getRepoBranch(projectId, env);
      }

      // Search for README.* files in the root directory using GitLab search
      // searchGitLabRepo expects a specific filename, not a pattern like "README+path:/"
      // We might need to iterate or use a broader search if GitLab API supports it,
      // or search for "README.md", then "README", etc.
      // For now, let's try "README.md" as a common default.
      const readmeResult = await searchGitLabRepo(
        projectId,
        "README.md", // filename
        env,
        docsBranch, // branch
        // ctx, // searchGitLabRepo doesn't take ctx
      );

      if (readmeResult) {
        content = readmeResult.content;
        const filename = readmeResult.path.split("/").pop() || readmeResult.path;
        fileUsed = filename; // e.g., "README.md"
        docsPath = constructGitlabUrl(
          projectId,
          readmeResult.path, // filePath
          docsBranch,
          env,
        );
        console.log(`Found README file via GitLab search: ${fileUsed}`);
      } else {
        console.log(`No README.md file found at root for GitLab project ${projectId}/${repo}`);
        // Optionally, try other README variations here if needed
      }
    }

    if (!content) {
      console.error(`Failed to find documentation for GitLab project ${projectId}/${repo}`);
    }
  }


  // Use projectId and repo for enqueueing
  if (projectId && repo) {
    ctx.waitUntil(
      enqueueDocumentationProcessing(
        projectId, // owner -> projectId
        repo,
        content,
        fileUsed,
        docsPath,
        docsBranch,
        env,
      ),
    );
  }

  if (!content) {
    content = "No documentation found.";
    return {
      fileUsed,
      content: [
        {
          type: "text" as const,
          text: content,
        },
      ],
    };
  }

  const result: FetchDocumentationResult = {
    fileUsed,
    content: [
      {
        type: "text" as const,
        text: content,
      },
    ],
  };

  // Use projectId and repo for caching
  if (projectId && repo) {
    ctx.waitUntil(
      cacheFetchDocResult(projectId, repo, result, cacheTTL, env).catch((error) => {
        console.warn(`Failed to cache fetch documentation result for GitLab project ${projectId}/${repo}: ${error}`);
      }),
    );
  }

  return result;
}

async function enqueueDocumentationProcessing(
  projectId: string, // Changed owner to projectId
  repoName: string, // Changed repo to repoName for clarity
  content: string | null,
  fileUsed: string,
  docsPath: string,
  docsBranch: string,
  env: Env & GitLabEnv, // Ensure env type compatibility
) {
  try {
    if (env.MY_QUEUE) {
      console.log("Enqueuing documentation processing for GitLab project", projectId, repoName);
      // Construct GitLab repository URL. This might vary based on GitLab instance (env.GITLAB_HOST)
      // Assuming projectId might be something like "group/project-name" or a numeric ID.
      // For a typical gitlab.com URL structure:
      const gitlabHost = env.GITLAB_HOST || "gitlab.com";
      // If projectId is numeric, this URL might not be directly browsable without knowing the full path.
      // If projectId is "group/repo", it forms a part of the path.
      // For simplicity, using projectId directly in the URL, assuming it's a path.
      const repoUrl = `https://${gitlabHost}/${projectId}/${repoName}`;


      // Prepare and send message to queue
      const message = {
        owner: projectId, // Using projectId as the equivalent of owner
        repo: repoName,
        repo_url: repoUrl,
        file_url: docsPath, // This should be the GitLab raw file URL
        content_length: content?.length,
        file_used: fileUsed,
        docs_branch: docsBranch,
      };

      await env.MY_QUEUE.send(JSON.stringify(message));
      console.log(
        `Queued documentation processing for GitLab project ${projectId}/${repoName}`,
        message,
      );
    } else {
      console.error("Queue 'MY_QUEUE' not available in environment");
    }
  } catch (error) {
    console.error(
      `Failed to enqueue documentation request for GitLab project ${projectId}/${repoName}`,
      error,
    );
  }
}

export async function searchRepositoryDocumentation({
  repoData,
  query,
  env,
  ctx,
  fallbackSearch = searchRepositoryDocumentationNaive,
}: {
  repoData: RepoData;
  query: string;
  env: CloudflareEnvironment;
  ctx: any;
  fallbackSearch?: typeof searchRepositoryDocumentationNaive;
}): Promise<{
  searchQuery: string;
  content: { type: "text"; text: string }[];
}> {
  if (!env.DOCS_BUCKET) {
    throw new Error("DOCS_BUCKET is not available in environment");
  }
  const docsInR2 = !!(await env.DOCS_BUCKET.head(
    `${repoData.owner}/${repoData.repo}/llms.txt`,
  ));
  if (docsInR2) {
    try {
      const autoragResult = await searchRepositoryDocumentationAutoRag({
        repoData,
        query,
        env,
        ctx,
        autoragPipeline: "docs-rag",
      });
      if (
        autoragResult?.content[0]?.text?.startsWith("No results found") ===
        false
      ) {
        console.log("Found results in AutoRAG", autoragResult);
        return autoragResult;
      }

      console.log("No results in AutoRAG", autoragResult);
    } catch (error) {
      console.error("Error in AutoRAG search", error);
    }
  }

  return await fallbackSearch({
    repoData,
    query,
    env,
    ctx,
  });
}

export async function searchRepositoryDocumentationAutoRag({
  repoData,
  query,
  env,
  ctx,
  autoragPipeline = "docs-rag",
}: {
  repoData: RepoData;
  query: string;
  env: CloudflareEnvironment & GitLabEnv; // Ensure env type compatibility
  ctx: any;
  autoragPipeline: string;
}): Promise<{
  searchQuery: string;
  content: { type: "text"; text: string }[];
}> {
  // Using repoData.owner as projectId for GitLab
  const projectId = repoData.owner;
  const repoName = repoData.repo;

  if (!projectId || !repoName) {
    return {
      searchQuery: query,
      content: [{ type: "text", text: "No repository data provided (GitLab project ID or repo name missing)" }],
    };
  }

  const repoPrefix = `${projectId}/${repoName}/`; // Adjusted for GitLab context (projectId/repoName)
  const searchRequest = {
    query: query,
    rewrite_query: true,
    max_num_results: 12,
    ranking_options: {
      score_threshold: 0.4,
    },
    filters: {
      type: "and",
      filters: [
        {
          type: "gte",
          key: "folder", // Assuming 'folder' key still works with new prefix structure
          value: `${repoPrefix}`,
        },
        {
          type: "lte",
          key: "folder",
          value: `${repoPrefix}~`,
        },
      ],
    },
  };

  const answer = await env.AI.autorag(autoragPipeline).search(searchRequest);

  let responseText =
    `## Query\n\n${query}.\n\n## Response\n\n` || // This part seems redundant if `query` is always defined
    `No results found for: "${query}"`;

  // Add source data if available
  if (answer.data && answer.data.length > 0) {
    const filteredData = answer.data.filter((item) => {
      // Ensure filtering uses projectId and repoName
      return item.filename.startsWith(`${projectId}/${repoName}/`);
    });

    if (filteredData.length > 0) {
      responseText +=
        "### Sources:\nImportant: you can fetch the full content of any source using the fetch_url_content tool\n";
      // Use projectId for getRepoBranch
      const defaultBranch = await getRepoBranch(
        projectId,
        env,
      );

      for (const item of filteredData) {
        // Use constructGitlabUrl and provide projectId
        let rawUrl = constructGitlabUrl(
          projectId,
          item.filename.replace(`${projectId}/${repoName}/`, ""), // filePath
          defaultBranch,
          env, // env might need GITLAB_HOST
        );

        // R2 URL construction uses projectId and repoName
        if (item.filename.endsWith(".ipynb.txt")) {
          rawUrl = `https://pub-39b02ce1b5a441b2a4658c1fc71dbb9c.r2.dev/${projectId}/${repoName}/${item.filename}`;
        }

        responseText += `\n#### (${item.filename})[${rawUrl}] (Score: ${item.score.toFixed(2)})\n`;

        if (item.content && item.content.length > 0) {
          for (const content of item.content) {
            if (content.text) {
              responseText += `- ${content.text}\n`;
            }
          }
        }
      }
    } else {
      responseText = `No results found for: "${query}"`;
    }
  } else {
    responseText = `No results found for: "${query}"`;
  }

  return {
    searchQuery: answer.search_query || query,
    content: [
      {
        type: "text",
        text: responseText,
      },
    ],
  };
}

/**
 * Search documentation using vector search
 * Will fetch and index documentation if none exists
 */
export async function searchRepositoryDocumentationNaive({
  repoData,
  query,
  forceReindex = false,
  env,
  ctx,
}: {
  repoData: RepoData;
  query: string;
  forceReindex?: boolean;
  env: CloudflareEnvironment;
  ctx: any;
}): Promise<{
  searchQuery: string;
  content: { type: "text"; text: string }[];
}> {
  // Initialize owner and repo
  let owner: string | null =
    repoData.owner ?? repoData.host.replace(/\./g, "_");
  let repo: string | null = repoData.repo ?? "docs";

  console.log(`Searching ${owner}/${repo}`);

  try {
    // Fetch the documentation - pass env
    const docResult = await fetchDocumentation({ repoData, env, ctx });
    const content = docResult.content[0].text;
    const fileUsed = docResult.fileUsed;

    console.log(
      `Fetched documentation from ${fileUsed} (${content.length} characters)`,
    );

    // Format search results as text for MCP response, or provide a helpful message if none
    const formattedText =
      `### Search Results for: "${query}"\n\n` +
      `No relevant documentation found for your query. It's either being indexed or the search query did not match any documentation.\n\n` +
      `As a fallback, this is the documentation for ${owner}/${repo}:\n\n` +
      `${content}\n\n` +
      `If you'd like to retry the search, try changing the query to increase the likelihood of a match.`;

    // Return search results in proper MCP format
    return {
      searchQuery: query,
      content: [
        {
          type: "text" as const,
          text: formattedText,
        },
      ],
    };
  } catch (error) {
    console.error(`Error in searchRepositoryDocumentation: ${error}`);
    return {
      searchQuery: query,
      content: [
        {
          type: "text" as const,
          text:
            `### Search Results for: "${query}"\n\n` +
            `An error occurred while searching the documentation. Please try again later.`,
        },
      ],
    };
  }
}

/**
 * Search for code in a GitHub repository
 * Uses the GitHub Search API to find code matching a query
 * Supports pagination for retrieving more results
 */
export async function searchRepositoryCode({
  repoData,
  query,
  page = 1,
  env,
  ctx,
}: {
  repoData: RepoData;
  query: string;
  page?: number;
  env: Env & GitLabEnv; // Ensure env type compatibility
  ctx: any;
}): Promise<{
  searchQuery: string;
  content: { type: "text"; text: string }[];
  pagination?: {
    totalCount: number;
    currentPage: number;
    perPage: number;
    hasMorePages: boolean;
    // totalPages: number; // GitLab search results might not directly provide total_pages
  };
}> {
  try {
    // Initialize projectId and repoName from repoData
    const projectId = repoData.owner; // Assuming owner is projectId for GitLab
    const repoName = repoData.repo; // repo is still repo name for display/logging

    if (!projectId || !repoName) {
      return {
        searchQuery: query,
        content: [
          {
            type: "text" as const,
            text: `### Code Search Results for: "${query}"\n\nCannot perform code search without GitLab repository information (projectId or repoName missing).`,
          },
        ],
      };
    }

    // Use fixed resultsPerPage of 20 (GitLab default/common) and normalize page value
    const currentPage = Math.max(1, page);
    const resultsPerPage = 20; // GitLab default per_page for search is 20

    console.log(
      `Searching code in GitLab project ${projectId} (repo: ${repoName})" (page ${currentPage}, ${resultsPerPage} per page)`,
    );

    // Using searchGitLabCode (aliased from gitlabClient's searchCode)
    // searchGitLabCode(projectId, query, env, page, perPage, branch)
    // Assuming no specific branch for now, or it needs to be passed in/determined
    const data = await searchGitLabCode(
      projectId,
      query,
      env, // GitLabEnv should be compatible
      currentPage,
      resultsPerPage,
      // undefined, // branch - let's assume default branch search or it's handled by API
    );

    // searchGitLabCode returns the JSON response directly or null.
    // GitLab API for code search returns an array of results.
    // It might not have a 'total_count' in the same way as GitHub.
    // Pagination headers (X-Total, X-Total-Pages, X-Per-Page, X-Page) are used.
    // For simplicity, we'll check if data is null or empty.
    // The `searchCode` in `gitlabClient` should return the parsed JSON array.

    if (!data || !Array.isArray(data) || data.length === 0) {
      const apiStatus = data === null ? "GitLab API request failed or returned null." : "No results.";
      return {
        searchQuery: query,
        content: [
          {
            type: "text" as const,
            text: `### Code Search Results for: "${query}"\n\nNo code matches found in GitLab project ${projectId} (repo: ${repoName}). ${apiStatus}`,
          },
        ],
      };
    }

    // GitLab search results are an array of objects.
    // We need to simulate totalCount if possible, or rely on headers (not directly available from searchGitLabCode's current return).
    // For now, let's assume the `data` array is the list of items for the current page.
    // To get totalCount, `searchGitLabCode` would need to return headers or the `gitlabApiRequest` would need to expose them.
    // Let's assume for now we can't easily get total_count without modifying gitlabClient.
    // We can say "more results might be available" if we get a full page.
    const itemsOnPage = data.length;
    const hasMorePages = itemsOnPage === resultsPerPage; // Heuristic

    // Format the search results
    let formattedResults = `### Code Search Results for: "${query}"\n\n`;
    formattedResults += `Found ${itemsOnPage} matches on this page in GitLab project ${projectId} (repo: ${repoName}).\n`;
    if (hasMorePages) {
        formattedResults += `More results may be available on subsequent pages.\n`;
    }
    formattedResults += `Page ${currentPage}.\n\n`;


    for (const item of data) { // data is the array of results
      // GitLab code search result items structure:
      // { "basename": "test.rb", "data": "...", "filename": "path/to/test.rb", "id": "...", "project_id": ..., "ref": "master", "startline": 10 }
      // We need to construct a user-friendly URL.
      const gitlabHost = env.GITLAB_HOST || "gitlab.com";
      // Assuming projectId can be a namespaced path for URL construction.
      // If projectId is numeric, this URL might not be directly user-friendly without the full project path.
      const fileUrl = `https://${gitlabHost}/${projectId}/${repoName}/-/blob/${item.ref}/${item.filename}`;

      formattedResults += `#### ${item.basename}\n`;
      formattedResults += `- **Path**: ${item.filename}\n`;
      formattedResults += `- **URL**: ${fileUrl}\n`; // Constructed URL
      formattedResults += `- **Branch**: ${item.ref}\n`;
      // GitLab API doesn't provide a direct "score" like GitHub's best match.
      // formattedResults += `- **Score**: ${item.score}\n\n`; // No direct score
      formattedResults += `\n`;
    }

    if (hasMorePages) {
      formattedResults += `_Showing ${itemsOnPage} results. Use pagination (increment page number) to see more results._\n\n`;
    }

    return {
      searchQuery: query,
      content: [
        {
          type: "text" as const,
          text: formattedResults,
        },
      ],
      pagination: {
        totalCount,
        currentPage,
        perPage: resultsPerPage,
        hasMorePages,
      },
    };
  } catch (error) {
    console.error(`Error in searchRepositoryCode: ${error}`);
    return {
      searchQuery: query,
      content: [
        {
          type: "text" as const,
          text: `### Code Search Results for: "${query}"\n\nAn error occurred while searching code: ${error}`,
        },
      ],
    };
  }
}

export async function fetchUrlContent({ url, env }: { url: string; env: Env }) {
  try {
    // Use the robotsTxt checking function to respect robots.txt rules
    const result = await fetchFileWithRobotsTxtCheck(url, env);

    if (result.blockedByRobots) {
      return {
        url,
        status: "blocked",
        content: [
          {
            type: "text" as const,
            text: `Access to ${url} is disallowed by robots.txt. GitMCP respects robots.txt directives.`,
          },
        ],
      };
    }

    if (!result.content) {
      return {
        url,
        status: "not_found",
        content: [
          {
            type: "text" as const,
            text: `Content at ${url} could not be retrieved. The resource may not exist or may require authentication.`,
          },
        ],
      };
    }

    let finalContent = result.content;

    // Convert HTML to markdown if content appears to be HTML
    if (
      finalContent.trim().startsWith("<!DOCTYPE") ||
      finalContent.trim().startsWith("<html") ||
      finalContent.includes("<body")
    ) {
      try {
        finalContent = htmlToMd(finalContent);
      } catch (error) {
        console.warn(`Error converting HTML to Markdown for ${url}: ${error}`);
        // Continue with the original content if conversion fails
      }
    }

    return {
      url,
      status: "success",
      content: [
        {
          type: "text" as const,
          text: finalContent,
        },
      ],
    };
  } catch (error) {
    console.error(`Error fetching ${url}: ${error}`);
    return {
      url,
      status: "error",
      content: [
        {
          type: "text" as const,
          text: `Error fetching content from ${url}: ${error}`,
        },
      ],
    };
  }
}

export const LIMIT = 51;

/**
 * Enforces the 50-character limit on the combined server and tool names
 * @param prefix - The prefix for the tool name (fetch_ or search_)
 * @param repo - The repository name
 * @param suffix - The suffix for the tool name (_documentation)
 * @returns A tool name that ensures combined length with server name stays under 50 characters
 */
export function enforceToolNameLengthLimit(
  prefix: string,
  repo: string | null | undefined,
  suffix: string,
): string {
  if (!repo) {
    console.error(
      "Repository name is null/undefined in enforceToolNameLengthLimit",
    );
    return `${prefix}${suffix}`;
  }

  // Generate the server name to check combined length
  const serverNameLen = generateServerName(repo).length;

  // Replace non-alphanumeric characters with underscores
  let repoName = repo.replace(/[^a-zA-Z0-9]/g, "_");
  let toolName = `${prefix}${repoName}${suffix}`;

  // Calculate combined length
  const combinedLength = toolName.length + serverNameLen;

  // If combined length is already under limit, return it
  if (combinedLength <= LIMIT) {
    return toolName;
  }

  const shorterSuffix = suffix === "_documentation" ? "_docs" : suffix;

  toolName = `${prefix}${repoName}${shorterSuffix}`;
  if (toolName.length + serverNameLen <= LIMIT) {
    return toolName;
  }

  // Step 2: Shorten the repo name by removing words
  const words = repoName.split("_");
  if (words.length > 1) {
    // Keep removing words from the end until we're under the limit or have only one word left
    let shortenedRepo = repoName;
    for (let i = words.length - 1; i > 0; i--) {
      shortenedRepo = words.slice(0, i).join("_");
      toolName = `${prefix}${shortenedRepo}${shorterSuffix}`;
      if (toolName.length + serverNameLen <= LIMIT) {
        return toolName;
      }
    }
  }

  const result = `${prefix}repo${shorterSuffix}`;
  if (result.length + serverNameLen <= LIMIT) {
    return result;
  }

  // Step 3: As a last resort, change repo name to "repo"
  return `${prefix}${shorterSuffix}`.replace(/__/g, "_");
}

/**
 * Generate a dynamic search tool name for the search_documentation tool based on the URL
 * @param requestHost - The host from the request
 * @param requestUrl - The full request URL (optional)
 * @returns A descriptive string for the tool name
 */
export function generateSearchToolName({ urlType, repo }: RepoData): string {
  try {
    // Default tool name as fallback
    let toolName = "search_documentation";
    if (urlType == "subdomain" || urlType == "github") {
      // Use enforceLengthLimit to ensure the tool name doesn't exceed 55 characters
      return enforceToolNameLengthLimit("search_", repo, "_documentation");
    }
    // replace non-alphanumeric characters with underscores
    return toolName.replace(/[^a-zA-Z0-9]/g, "_");
  } catch (error) {
    console.error("Error generating search tool name:", error);
    // Return default tool name if there's any error parsing the URL
    return "search_documentation";
  }
}

/**
 * Generate a dynamic description for the search_documentation tool based on the URL
 * @param requestHost - The host from the request
 * @param requestUrl - The full request URL (optional)
 * @returns A descriptive string for the tool
 */
export function generateSearchToolDescription({
  urlType,
  owner,
  repo,
}: RepoData): string {
  try {
    // Default description as fallback
    let description =
    "Semantically search within the fetched documentation for the current GitLab repository."; // Changed to GitLab

    if (urlType == "subdomain") {
    // This part relates to GitHub Pages usually. If GitLab Pages is intended, text needs adjustment.
    // For now, keeping it generic or more aligned with GitLab.
    description = `Semantically search within the fetched documentation from the ${owner}/${repo} GitLab Pages (if applicable) or repository. Useful for specific queries.`;
  } else if (urlType == "github") { // Assuming 'github' urlType now refers to GitLab
    description = `Semantically search within the fetched documentation from GitLab repository: ${owner}/${repo}. Useful for specific queries.`;
    }

    return description;
  } catch (error) {
    // Return default description if there's any error parsing the URL
    return "Search documentation for the current repository.";
  }
}

/**
 * Generate a dynamic description for the fetch_documentation tool based on the URL
 * @param requestHost - The host from the request
 * @param requestUrl - The full request URL (optional)
 * @returns A descriptive string for the tool
 */
export function generateFetchToolDescription({
  urlType,
  owner,
  repo,
}: Omit<RepoData, "host">): string {
  try {
    // Default description as fallback
  description = "Fetch entire documentation for the current GitLab repository."; // Changed to GitLab

    if (urlType == "subdomain") {
    // Again, for GitLab Pages or general repo docs.
    description = `Fetch entire documentation file from the ${owner}/${repo} GitLab Pages (if applicable) or repository. Useful for general questions. Always call this tool first if asked about ${owner}/${repo}.`;
  } else if (urlType == "github") { // Assuming 'github' urlType now refers to GitLab
    description = `Fetch entire documentation file from GitLab repository: ${owner}/${repo}. Useful for general questions. Always call this tool first if asked about ${owner}/${repo}.`;
    }

    return description;
  } catch (error) {
    // Return default description if there's any error parsing the URL
    return "Fetch documentation for the current repository.";
  }
}

/**
 * Generate a dynamic tool name for the fetch_documentation tool based on the URL
 * @param requestHost - The host from the request
 * @param requestUrl - The full request URL (optional)
 * @returns A descriptive string for the tool
 */
export function generateFetchToolName({
  urlType,
  owner,
  repo,
}: Omit<RepoData, "host">): string {
  try {
    // Default tool name as fallback
    let toolName = "fetch_documentation";

    if (urlType == "subdomain" || urlType == "github") {
      // Use enforceLengthLimit to ensure the tool name doesn't exceed 55 characters
      return enforceToolNameLengthLimit("fetch_", repo, "_documentation");
    }

    // replace non-alphanumeric characters with underscores
    return toolName.replace(/[^a-zA-Z0-9]/g, "_");
  } catch (error) {
    console.error("Error generating tool name:", error);
    // Return default tool name if there's any error parsing the URL
    return "fetch_documentation";
  }
}

/**
 * Generate a dynamic tool name for the code search tool based on the URL
 * @param repoData - The repository data object
 * @returns A descriptive string for the tool
 */
export function generateCodeSearchToolName({
  urlType,
  repo,
}: RepoData): string {
  try {
    // Default tool name as fallback
    let toolName = "search_code";
    if (urlType == "subdomain" || urlType == "github") {
      // Use enforceLengthLimit to ensure the tool name doesn't exceed 55 characters
      return enforceToolNameLengthLimit("search_", repo, "_code");
    }
    // replace non-alphanumeric characters with underscores
    return toolName.replace(/[^a-zA-Z0-9]/g, "_");
  } catch (error) {
    console.error("Error generating code search tool name:", error);
    // Return default tool name if there's any error parsing the URL
    return "search_code";
  }
}

/**
 * Generate a dynamic description for the code search tool based on the URL
 * @param repoData - The repository data object
 * @returns A descriptive string for the tool
 */
export function generateCodeSearchToolDescription({
  owner,
  repo,
}: RepoData): string {
  return `Search for code within the GitLab repository: "${owner}/${repo}" using the GitLab Search API (exact match). Returns matching files for you to query further if relevant.`; // Changed to GitLab
}

/**
 * Recursively list every subfolder prefix under `startPrefix`.
 * @param {R2Bucket} bucket – the Workers-bound R2 bucket
 * @param {string} startPrefix – e.g. "path/to/folder/"
 * @returns {Promise<string[]>}
 */
async function listAllSubfolders(bucket: R2Bucket, startPrefix: string) {
  const all: string[] = [];

  // Define an inner async recursion
  async function recurse(prefix: string) {
    let cursor;
    do {
      // 1. List one page of prefixes under `prefix`
      const listResult = await bucket.list({ prefix, delimiter: "/", cursor });
      const { delimitedPrefixes = [], truncated } = listResult;

      // 2. For each child prefix, record it and recurse into it
      // Ensure the child prefix ends with '/' before adding/recursing
      for (const childPrefix of delimitedPrefixes) {
        const ensuredChildPrefix = childPrefix.endsWith("/")
          ? childPrefix
          : childPrefix + "/";
        all.push(ensuredChildPrefix);
        await recurse(ensuredChildPrefix);
      }
      cursor = truncated ? listResult.cursor : undefined;
    } while (cursor);
  }

  // Kick off recursion
  await recurse(startPrefix);
  return Array.from(new Set(all)); // dedupe just in case
}
