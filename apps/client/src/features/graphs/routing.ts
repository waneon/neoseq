import { LOCAL_REPOSITORY_ID } from "../repositories/directory";

export function graphPath(repositoryId: string, graphId: string, suffix = ""): string {
  const encodedGraph = encodeURIComponent(graphId);
  const tail = suffix ? `/${suffix.replace(/^\/+/, "")}` : "";
  if (repositoryId === LOCAL_REPOSITORY_ID) return `/g/${encodedGraph}${tail}`;
  return `/r/${encodeURIComponent(repositoryId)}/g/${encodedGraph}${tail}`;
}
