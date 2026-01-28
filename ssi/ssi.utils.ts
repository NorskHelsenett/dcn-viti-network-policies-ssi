import {
  HTTPError,
  NAMAPIEndpoint,
  NAMVitiNetworkPolicy,
  NetboxDriver,
  NetboxPaginated,
  NetboxPrefix,
  VMwareNSXDriver,
} from "@norskhelsenett/zeniki";
// import logger from "./loggers/logger.ts";
import ipaddr from "ipaddr.js";
import { Validator } from "ip-num";
// import { SSIWorker } from "./ssi.worker.ts";
import {
  getGroupIPAddresses,
  getVMIPAddresses,
} from "./services/nsx.service.ts";
import logger from "./loggers/logger.ts";
import { simpleGit, SimpleGitOptions } from "simple-git";
import { prepareGitRepo } from "./services/git.service.ts";
import YAML from "yaml";

interface K8SNetworkPolicyIPBlock {
  ipBlock: {
    cidr: string;
  };
}

export const processVitiNetworkPolicy = async (
  vitiNetworkPolicy: NAMVitiNetworkPolicy,
) => {
  try {
    console.log(`Processing policy ${vitiNetworkPolicy.name}...`);

    // Get IPAM prefixes
    const ipam = configureIPAM(
      vitiNetworkPolicy.netbox_endpoint as NAMAPIEndpoint,
    );
    const url = new URL(
      vitiNetworkPolicy.query as string,
    );

    const netboxPrefixes = (await ipam.getPaginatedByUrl<
      NetboxPaginated<NetboxPrefix>
    >(
      `${url.pathname.replace("/api", "")}${url.search}&limit=500`,
      {},
      true,
    ).catch((error: HTTPError) => {
      logger.error(
        `Error fetching prefixes from IPAM for VITI Network Policy ${vitiNetworkPolicy.name}: ${error.message}`,
        {
          component: "ssi.utils",
          method: "processVitiNetworkPolicy",
        },
      );
      throw error;
    }) as NetboxPaginated<NetboxPrefix>).results;

    const netboxIPs = netboxPrefixes.map((p) => p.prefix);

    const IPAddresses: Set<string>[] = [];
    IPAddresses.push(new Set<string>());

    // Get VM IPs and Group IPs from NSX
    const vmIPs = await getVMIPAddresses(vitiNetworkPolicy);
    const groupIPs = await getGroupIPAddresses(vitiNetworkPolicy);

    // Combine all IPs into a single Set to avoid duplicates
    for (const ip of groupIPs[0]) {
      IPAddresses[0].add(ip);
    }
    for (const ip of vmIPs[0]) {
      IPAddresses[0].add(ip);
    }
    for (const ip of netboxIPs) {
      IPAddresses[0].add(ip as string);
    }

    // Filter out link-local addresses from Set and prepare array
    const filteredIPAddresses = filterLinkLocal(Array.from(IPAddresses[0]));

    // Prepare K8s NetworkPolicy IPBlocks
    const K8SIPBlocks = prepareK8S(filteredIPAddresses);

    // Prepare Cilium CIDRs
    const ciliumCidrs = prepareCilium(filteredIPAddresses);

    // Sort results
    const sortedK8SIPBlocks = K8SIPBlocks.sort((a, b) => {
      if (a.ipBlock.cidr < b.ipBlock.cidr) return -1;
      if (a.ipBlock.cidr > b.ipBlock.cidr) return 1;
      return 0;
    });

    const sortedCiliumCidrs = ciliumCidrs.sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });

    // Prepare the JSON
    const kubernetesNetworkPolicyJSON = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: vitiNetworkPolicy.name,
      },
      spec: {
        podSelector: {
          matchLabels: {
            "network-policies": vitiNetworkPolicy.name,
          },
        },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: sortedK8SIPBlocks,
          },
        ],
      },
    };

    const ciliumGroupJSON = {
      apiVersion: "cilium.io/v2alpha1",
      kind: "CiliumCIDRGroup",
      metadata: {
        name: vitiNetworkPolicy.name,
      },
      spec: {
        externalCIDRs: sortedCiliumCidrs,
      },
    };

    console.log("Cilium Group JSON:", JSON.stringify(ciliumGroupJSON, null, 2));

    // GIT Operations
    const gitConfigs = vitiNetworkPolicy.git_configs;

    for (const config of gitConfigs) {
      const gitEndpoint = config.endpoint;
      const gitBranch = config.branch;
      console.log(
        `Preparing to commit NetworkPolicy ${vitiNetworkPolicy.name} to Git repository ${config.endpoint.name} - Branch ${config.branch}...`,
      );

      if (!gitEndpoint || !gitBranch) {
        console.log("Git endpoint or branch not defined.");
        throw new Error("Git endpoint or branch not defined.");
      }

      const gitUrlRegex = /\/([^\/]+)\.git$/;
      const repoNameMatch = gitEndpoint.url.match(gitUrlRegex);

      if (!repoNameMatch) {
        console.log("Invalid Git repository URL.");
        throw new Error("Invalid Git repository URL.");
      }

      // const repoName = repoNameMatch[1];
      // const integratorRepoPath = path.join(repoDirectory, repoName);
      const repoUrlWithKey = gitEndpoint.url.replace(
        /^https:\/\//,
        `https://token:${gitEndpoint.key}@`,
      );

      const repoDir = Deno.env.get("REPO_DIR");

      const gitOptions: Partial<SimpleGitOptions> = {
        baseDir: `${repoDir}/${repoNameMatch[1]}`,
        binary: "git",
        maxConcurrentProcesses: 6,
      };

      // If the repo isn't cloned prepare the repo

      try {
        await Deno.stat(`
          ${repoDir}/${repoNameMatch[1]}`);
        // console.log(
        //   `Git repository ${repoNameMatch[1]} already exists locally.`,
        // );
      } catch (_error) {
        // console.log(
        //   `Git repository ${
        //     repoNameMatch[1]
        //   } does not exist locally. Cloning...`,
        // );
        await prepareGitRepo(
          gitOptions,
          gitBranch,
          repoUrlWithKey,
        );
      }

      // Init simpleGit and fetch branches
      const git = simpleGit(gitOptions);
      await git.fetch();
      const branches = await git.branch();

      // Check if the branch exists locally or remotely
      if (
        !branches.all.includes(gitBranch) &&
        !branches.all.includes(`remotes/origin/${gitBranch}`)
      ) {
        await git.checkoutLocalBranch(gitBranch);
      } else {
        await git.checkout(gitBranch);
        await git.pull("origin", gitBranch);
      }

      // Check if the branch has an upstream configured
      // Push the branch to the remote if not
      let gitStatus = await git.status();
      if (!gitStatus.tracking) {
        await git.push("origin", gitBranch, { "--set-upstream": null });
      }

      // Ensure directories exist
      try {
        await Deno.stat(
          `${repoDir}/${repoNameMatch[1]}/kubernetesNetworkPolicies`,
        );
      } catch {
        await Deno.mkdir(
          `${repoDir}/${repoNameMatch[1]}/kubernetesNetworkPolicies`,
        );
      }

      try {
        await Deno.stat(`${repoDir}/${repoNameMatch[1]}/ciliumGroups`);
      } catch {
        await Deno.mkdir(`${repoDir}/${repoNameMatch[1]}/ciliumGroups`);
      }

      // Write files
      const fileName = `${vitiNetworkPolicy.name}.yaml`;
      await Deno.writeTextFile(
        `${repoDir}/${repoNameMatch[1]}/kubernetesNetworkPolicies/${fileName}`,
        YAML.stringify(kubernetesNetworkPolicyJSON),
      );

      await Deno.writeTextFile(
        `${repoDir}/${repoNameMatch[1]}/ciliumGroups/${fileName}`,
        YAML.stringify(ciliumGroupJSON),
      );

      // Refresh git status and check if git is clean
      gitStatus = await git.status();

      // If not clean; add, commit and push
      if (!gitStatus.isClean()) {
        await git.add("./*");
        await git.commit(`Update ${fileName}`);
        await git.push("origin", gitBranch);
        logger.debug(
          `dcn-viti-network-policies-ssi: ${fileName} pushed to branch ${gitBranch} on ${
            repoNameMatch[1]
          }`,
        );
      } else {
        logger.debug(
          `dcn-viti-network-policies-ssi: No changes to commit for ${fileName} on branch ${gitBranch} on ${
            repoNameMatch[1]
          }`,
        );
      }
    }
  } catch (error) {
    throw error;
  }
};

export const prepareCilium = (IPAddresses: string[]) => {
  try {
    const cidrs: string[] = [];
    for (const ip of IPAddresses) {
      if (Validator.isValidIPv4CidrNotation(ip)[0]) {
        cidrs.push(`${ip}`);
      } else if (Validator.isValidIPv4String(ip)[0]) {
        cidrs.push(`${ip}/32`);
      } else if (Validator.isValidIPv6String(ip)[0]) {
        cidrs.push(`${ip}/128`);
      } else if (Validator.isValidIPv6CidrNotation(ip)[0]) {
        cidrs.push(`${ip}`);
      }
    }

    return cidrs;
  } catch (error) {
    throw error;
  }
};

export const prepareK8S = (
  IPAaddresses: string[],
): K8SNetworkPolicyIPBlock[] => {
  try {
    const ipBlocks: K8SNetworkPolicyIPBlock[] = [];
    for (const ip of IPAaddresses) {
      if (Validator.isValidIPv4CidrNotation(ip)[0]) {
        ipBlocks.push({ ipBlock: { cidr: `${ip}` } });
      } else if (Validator.isValidIPv4String(ip)[0]) {
        ipBlocks.push({ ipBlock: { cidr: `${ip}/32` } });
      } else if (Validator.isValidIPv6String(ip)[0]) {
        ipBlocks.push({ ipBlock: { cidr: `${ip}/128` } });
      } else if (Validator.isValidIPv6CidrNotation(ip)[0]) {
        ipBlocks.push({ ipBlock: { cidr: `${ip}` } });
      }
    }

    return ipBlocks;
  } catch (error) {
    throw error;
  }
};

export const filterLinkLocal = (ipAddresses: string[]) =>
  ipAddresses.filter((address) => {
    // Exclude ranges. Not supported in network policies
    if (address.includes("-")) return false;

    // Support both "ip" and "ip/prefix"
    const ipStr = address.split("/")[0];

    try {
      const ip = ipaddr.parse(ipStr);
      return ip.range() !== "linkLocal";
    } catch {
      // if parsing fails, exclude the address
      return false;
    }
  });

/**
 * Configures the VMware NSX driver with endpoint credentials
 */
export const configureNSX = (endpoint: NAMAPIEndpoint) => {
  const username = endpoint?.user + "";
  const password = endpoint?.pass + "";
  const authString = `${username}:${password}`;
  const encodedAuth = btoa(authString);
  return new VMwareNSXDriver({
    baseURL: endpoint?.url?.replace(
      "/api/v1",
      "",
    ).replace("/global-manager", ""),
    headers: {
      "User-Agent": Deno.env.get("USER_AGENT") ?? "Unknown",
      "Content-Type": "application/json",
      Authorization: `Basic ${encodedAuth}`,
    },
    // TODO: Figure out proper timeout, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
};

/**
 * Configures the IPAM driver with endpoint credentials
 */
const configureIPAM = (endpoint: NAMAPIEndpoint) => {
  return new NetboxDriver({
    baseURL: endpoint.url.replace("/api/", "/api"),
    headers: {
      "User-Agent": Deno.env.get("USER_AGENT") ?? "Unknown",
      "Content-Type": "application/json",
      Authorization: `Token ${endpoint.key}`,
    },
    // TODO: Figure out proper timeout, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
};
