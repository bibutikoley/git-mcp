// src/api/utils/gitlabClient.ts

// Assuming 'fetch' is available globally or imported elsewhere if needed.
// For Node.js environment, you might need: import fetch, { Response, RequestInit } from 'node-fetch';

export interface GitLabEnv {
  GITLAB_HOST?: string;
  GITLAB_TOKEN: string;
}

const DEFAULT_GITLAB_HOST = 'gitlab.com';
const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const NETWORK_RETRY_DELAY_MS = 2000;
const USER_AGENT = 'GitLabAPIClient/1.0';

/**
 * Makes a request to the GitLab API.
 *
 * @param url The specific API endpoint (e.g., /api/v4/projects)
 * @param options RequestInit options for fetch
 * @param env Environment object containing GITLAB_HOST and GITLAB_TOKEN
 * @param retryCount Current retry attempt
 * @returns The API Response object or null if all retries fail.
 */
export async function gitlabApiRequest(
  url: string,
  options: RequestInit,
  env: GitLabEnv,
  retryCount: number = 0,
): Promise<Response | null> {
  const gitlabHost = env.GITLAB_HOST || DEFAULT_GITLAB_HOST;
  const fullUrl = `https://${gitlabHost}${url.startsWith('/') ? url : `/${url}`}`;

  const headers = {
    ...options.headers,
    'PRIVATE-TOKEN': env.GITLAB_TOKEN,
    'User-Agent': USER_AGENT,
  };

  try {
    const response = await fetch(fullUrl, { ...options, headers });

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      console.warn(`GitLab API rate limit hit for ${fullUrl}. Retrying... (attempt ${retryCount + 1})`);
      const retryAfterHeader = response.headers.get('Retry-After');
      let waitSeconds = DEFAULT_RETRY_AFTER_SECONDS;
      if (retryAfterHeader) {
        const parsedRetryAfter = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedRetryAfter)) {
          waitSeconds = parsedRetryAfter;
        }
      }
      console.log(`Waiting for ${waitSeconds} seconds before retrying.`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      return gitlabApiRequest(url, options, env, retryCount + 1);
    }

    if (!response.ok && response.status !== 429) { // Don't retry non-429 errors here, let caller handle
      console.error(`GitLab API request failed for ${fullUrl}: ${response.status} ${response.statusText}`);
      // Optionally, could log response.text() for more details if needed, but be cautious with sensitive data.
      return response; // Return the error response for the caller to inspect
    }
    
    return response;

  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
        console.error(`GitLab API request aborted for ${fullUrl}: ${error.message}`);
        return null;
    }
    
    if (retryCount < MAX_RETRIES) {
      console.warn(`Network error during GitLab API request for ${fullUrl}: ${(error as Error).message}. Retrying... (attempt ${retryCount + 1})`);
      await new Promise(resolve => setTimeout(resolve, NETWORK_RETRY_DELAY_MS));
      return gitlabApiRequest(url, options, env, retryCount + 1);
    } else {
      console.error(`Max retries reached for GitLab API request to ${fullUrl} due to network errors: ${(error as Error).message}`);
      return null;
    }
  }
}

/**
 * Searches for a file by name in a GitLab project.
 *
 * @param filename The name of the file to search for.
 * @param projectId The ID or URL-encoded path of the project.
 * @param env Environment object.
 * @param branch Optional branch name.
 * @returns The JSON response or null if the request fails.
 */
export async function searchFileByName(
  filename: string,
  projectId: string | number,
  env: GitLabEnv,
  branch?: string,
): Promise<any | null> {
  let searchUrl = `/api/v4/projects/${encodeURIComponent(projectId)}/search?scope=blobs&search=${encodeURIComponent(filename)}`;
  if (branch) {
    searchUrl += `&ref=${encodeURIComponent(branch)}`;
  }

  const response = await gitlabApiRequest(searchUrl, { method: 'GET' }, env);

  if (response && response.ok) {
    try {
      return await response.json();
    } catch (error) {
      console.error(`Error parsing JSON response from searchFileByName for project ${projectId}, file ${filename}: ${(error as Error).message}`);
      return null;
    }
  }
  if (response) {
    console.error(`searchFileByName failed for project ${projectId}, file ${filename}: ${response.status} ${response.statusText}`);
  }
  return null;
}

/**
 * Fetches the raw content of a file from a GitLab project.
 *
 * @param projectId The ID or URL-encoded path of the project.
 * @param filePath The URL-encoded path to the file.
 * @param branch The branch name.
 * @param env Environment object.
 * @returns The text content of the file or null if the request fails.
 */
export async function fetchRawFile(
  projectId: string | number,
  filePath: string,
  branch: string,
  env: GitLabEnv,
): Promise<string | null> {
  // filePath needs to be URL-encoded, but individual path segments.
  // Example: lib/class.rb -> lib%2Fclass.rb
  const encodedFilePath = filePath.split('/').map(encodeURIComponent).join('/');
  const fileUrl = `/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodedFilePath}/raw?ref=${encodeURIComponent(branch)}`;

  const response = await gitlabApiRequest(fileUrl, { method: 'GET' }, env);

  if (response && response.ok) {
    try {
      return await response.text();
    } catch (error) {
      console.error(`Error reading text response from fetchRawFile for project ${projectId}, file ${filePath}: ${(error as Error).message}`);
      return null;
    }
  }
  if (response) {
    console.error(`fetchRawFile failed for project ${projectId}, file ${filePath}: ${response.status} ${response.statusText}`);
  }
  return null;
}

/**
 * Searches for code within a GitLab project.
 *
 * @param projectId The ID or URL-encoded path of the project.
 * @param query The search query.
 * @param env Environment object.
 * @param page Page number (default 1).
 * @param perPage Results per page (default 20).
 * @param branch Optional branch name.
 * @returns The JSON response or null if the request fails.
 */
export async function searchCode(
  projectId: string | number,
  query: string,
  env: GitLabEnv,
  page: number = 1,
  perPage: number = 20,
  branch?: string,
): Promise<any | null> {
  let searchUrl = `/api/v4/projects/${encodeURIComponent(projectId)}/search?scope=blobs&search=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
  if (branch) {
    searchUrl += `&ref=${encodeURIComponent(branch)}`;
  }

  const response = await gitlabApiRequest(searchUrl, { method: 'GET' }, env);

  if (response && response.ok) {
    try {
      return await response.json();
    } catch (error) {
      console.error(`Error parsing JSON response from searchCode for project ${projectId}, query "${query}": ${(error as Error).message}`);
      return null;
    }
  }
  if (response) {
     console.error(`searchCode failed for project ${projectId}, query "${query}": ${response.status} ${response.statusText}`);
  }
  return null;
}
