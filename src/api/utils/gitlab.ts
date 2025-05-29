// src/api/utils/gitlab.ts

import {
  gitlabApiRequest,
  searchFileByName,
  fetchRawFile,
  GitLabEnv, // Assuming GitLabEnv is exported from gitlabClient.ts
} from './gitlabClient';

const DEFAULT_GITLAB_HOST = 'gitlab.com';

/**
 * Defines the structure for a GitLab file.
 */
export interface GitLabFile {
  path: string;
  content: string;
}

/**
 * Constructs the full raw file URL for a file in GitLab.
 *
 * @param projectId The ID or URL-encoded path of the project.
 * @param filePath The path to the file within the repository.
 * @param branch The branch name.
 * @param env Environment object, requires GITLAB_HOST (optional).
 * @returns The full URL string to the raw file.
 */
export function constructGitlabUrl(
  projectId: string | number,
  filePath: string,
  branch: string,
  env: { GITLAB_HOST?: string },
): string {
  const gitlabHost = env.GITLAB_HOST || DEFAULT_GITLAB_HOST;
  // Ensure filePath is properly encoded for a URL, especially if it contains special characters.
  // However, the /api/v4/projects/:projectId/repository/files/:filePath/raw endpoint expects filePath to be URL-encoded.
  // Individual segments of the path should be encoded.
  const encodedFilePath = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://${gitlabHost}/api/v4/projects/${encodeURIComponent(projectId.toString())}/repository/files/${encodedFilePath}/raw?ref=${encodeURIComponent(branch)}`;
}

/**
 * Fetches the content of a file from GitLab.
 *
 * @param projectId The ID or URL-encoded path of the project.
 * @param branch The branch name.
 * @param filePath The path to the file.
 * @param env GitLab environment object containing GITLAB_TOKEN and optionally GITLAB_HOST.
 * @returns The file content as a string, or null if not found or an error occurs.
 */
export async function fetchFileFromGitLab(
  projectId: string | number,
  branch: string,
  filePath: string,
  env: GitLabEnv,
): Promise<string | null> {
  return fetchRawFile(projectId, filePath, branch, env);
}

/**
 * Searches for a file in a GitLab repository and fetches its content.
 *
 * @param projectId The ID or URL-encoded path of the project.
 * @param filename The name of the file to search for.
 * @param env GitLab environment object.
 * @param branch Optional branch name. If not provided, search will be across all branches (or default if API implies).
 * @returns A GitLabFile object { path: string, content: string } or null if not found or an error occurs.
 */
export async function searchGitLabRepo(
  projectId: string | number,
  filename: string,
  env: GitLabEnv,
  branch?: string,
): Promise<GitLabFile | null> {
  const searchResults = await searchFileByName(filename, projectId, env, branch);

  if (searchResults && searchResults.length > 0) {
    const firstMatch = searchResults[0];
    if (firstMatch && firstMatch.path) {
      // If a branch was specified for the search, use it to fetch the file.
      // If no branch was specified for search, the searchResult might contain 'ref' or we might need a default.
      // For simplicity, and because searchFileByName takes a branch, we assume that branch is the correct one.
      // If 'branch' wasn't provided to searchGitLabRepo, we'd need to determine it, e.g., by using getRepoBranch or from search result's 'ref'.
      // However, fetchFileFromGitLab *requires* a branch.
      // Let's assume if branch is undefined here, we should try to get the default branch.
      const branchToFetch = branch || (await getRepoBranch(projectId, env));

      if (!branchToFetch) {
        console.error(`Cannot fetch file ${firstMatch.path} from project ${projectId} because branch could not be determined.`);
        return null;
      }

      const content = await fetchFileFromGitLab(projectId, branchToFetch, firstMatch.path, env);
      if (content !== null) {
        return { path: firstMatch.path, content };
      } else {
        console.warn(`File ${firstMatch.path} found in search but content could not be fetched from project ${projectId} on branch ${branchToFetch}.`);
        return null;
      }
    }
  }
  console.log(`File "${filename}" not found in project ${projectId}${branch ? ` on branch ${branch}` : ''}.`);
  return null;
}

/**
 * Gets the default branch of a GitLab project.
 * Falls back to checking for 'main', then 'master', then defaults to 'main'.
 *
 * @param projectId The ID or URL-encoded path of the project.
 * @param env GitLab environment object.
 * @returns The default branch name as a string.
 */
export async function getRepoBranch(
  projectId: string | number,
  env: GitLabEnv,
): Promise<string> {
  const projectUrl = `/api/v4/projects/${encodeURIComponent(projectId.toString())}`;
  let response = await gitlabApiRequest(projectUrl, { method: 'GET' }, env);

  if (response && response.ok) {
    try {
      const projectDetails = await response.json();
      if (projectDetails && projectDetails.default_branch) {
        return projectDetails.default_branch;
      }
    } catch (error) {
      console.error(`Error parsing project details JSON for project ${projectId}: ${(error as Error).message}`);
      // Proceed to try listing branches
    }
  } else {
    console.warn(`Failed to fetch project details for project ${projectId} (status: ${response?.status}). Attempting to list branches.`);
  }

  // If default_branch is not found or project request failed, try listing branches
  const branchesUrl = `/api/v4/projects/${encodeURIComponent(projectId.toString())}/repository/branches`;
  response = await gitlabApiRequest(branchesUrl, { method: 'GET' }, env);

  if (response && response.ok) {
    try {
      const branches = await response.json();
      if (Array.isArray(branches)) {
        const mainBranch = branches.find(b => b.name === 'main');
        if (mainBranch) return 'main';
        const masterBranch = branches.find(b => b.name === 'master');
        if (masterBranch) return 'master';
        if (branches.length > 0) { // Return the first branch if specific ones aren't found
            console.warn(`No 'main' or 'master' branch found for project ${projectId}. Returning first available branch: ${branches[0].name}`);
            return branches[0].name;
        }
      }
    } catch (error) {
      console.error(`Error parsing branches list JSON for project ${projectId}: ${(error as Error).message}`);
    }
  } else {
     console.warn(`Failed to list branches for project ${projectId} (status: ${response?.status}).`);
  }

  console.warn(`Could not determine default branch for project ${projectId}. Defaulting to 'main'.`);
  return 'main'; // Fallback
}
