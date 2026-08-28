/** Browser stub: the local Docker VM is a desktop capability and is gated off. */
export function getLocalDockerStatus(): Promise<never> {
  return Promise.reject(new Error("The local Docker VM is a desktop capability."));
}

export function startLocalDockerBox(): Promise<never> {
  return Promise.reject(new Error("The local Docker VM is a desktop capability."));
}

export function stopLocalDockerBox(): Promise<never> {
  return Promise.reject(new Error("The local Docker VM is a desktop capability."));
}
