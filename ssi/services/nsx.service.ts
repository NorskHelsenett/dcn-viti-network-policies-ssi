import {
  HTTPError,
  isDevMode,
  NAMAPIEndpoint,
  NAMVitiNetworkPolicy,
  NetboxTag,
  VMwareNSXDriver,
  VMwareNSXGroup,
  VMwareNSXResponse,
  VMwareNSXTag,
  VMwareNSXVirtualMachine,
} from "@norskhelsenett/zeniki";
import logger from "../loggers/logger.ts";
import { configureNSX, filterLinkLocal } from "../ssi.utils.ts";

export const getGroupIPAddresses = async (
  vitiNetworkPolicy: NAMVitiNetworkPolicy,
) => {
  try {
    const groupIPs: Set<string>[] = [];
    groupIPs.push(new Set<string>());

    for (const manager of vitiNetworkPolicy.nsx_managers as NAMAPIEndpoint[]) {
      const nsx = configureNSX(manager);
      for (const tag of vitiNetworkPolicy.group_tags as NetboxTag[]) {
        const managerGroups = await getGroupsFromManager(
          nsx,
          manager,
          vitiNetworkPolicy.scope,
          tag.name,
        );

        if (manager.type === "global") {
          for (const group of managerGroups) {
            for (const expression of group.expression!) {
              if (expression.ip_addresses) {
                expression.ip_addresses.forEach((ip) => groupIPs[0].add(ip));
              }
            }
          }
        } else {
          for (const group of managerGroups) {
            const policyPath = group.tags?.find((group_tag: VMwareNSXTag) => {
              return group_tag.scope === "policyPath";
            });
            const groupPath = policyPath?.tag as string;
            const ips = await getGroupMemberIPs(nsx, groupPath);

            for (const ip of ips) {
              groupIPs[0].add(ip);
            }
          }
        }
      }
    }

    return groupIPs;
  } catch (error) {
    throw error;
  }
};

const getGroupsFromManager = async (
  nsx: VMwareNSXDriver,
  manager: NAMAPIEndpoint,
  scope: string,
  tag: string,
) => {
  try {
    const resourceType = manager.type === "global" ? "Group" : "NSGroup";
    const globalManager = manager.type === "global";
    const scopedGroups = (await nsx.search.query<
      VMwareNSXGroup
    >({
      "query": `resource_type:${resourceType} AND tags.scope:${scope}`,
    }, globalManager).catch((error: HTTPError) => {
      logger.error(
        `nam-firewall-exposed-vms-ssi: Failed to get tagged Groups from '${nsx.getHostname()}': ${error.message}`,
        {
          component: "nsx.service",
          method: "getTaggedGroups",
          error: isDevMode() ? error : error?.message,
        },
      );
      throw error;
    }) as VMwareNSXResponse<VMwareNSXGroup>).results;

    const taggedGroups = scopedGroups.filter((group) =>
      group.tags?.some((t) => t.scope === scope && t.tag === tag)
    );

    return taggedGroups;
  } catch (error) {
    throw error;
  }
};

export const getVMIPAddresses = async (
  vitiNetworkPolicy: NAMVitiNetworkPolicy,
) => {
  try {
    const virtualMachineIPs: Set<string>[] = [];
    virtualMachineIPs.push(new Set<string>());
    for (const manager of vitiNetworkPolicy.nsx_managers as NAMAPIEndpoint[]) {
      if (manager.type === "global_managed") {
        for (const tag of vitiNetworkPolicy.vm_tags as NetboxTag[]) {
          const nsx = configureNSX(manager);

          const managerVms: VMwareNSXVirtualMachine[] = await getVMsFromLM(
            nsx,
            vitiNetworkPolicy.scope,
            tag.name,
          );
          for (const vm of managerVms) {
            const ips = await extractVirtualMachineIPs(nsx, vm);
            for (const ip of ips) {
              virtualMachineIPs[0].add(ip);
            }
          }
        }
      }
    }

    return virtualMachineIPs;
  } catch (error) {
    throw error;
  }
};

const getVMsFromLM = async (
  nsx: VMwareNSXDriver,
  scope: string,
  tag: string,
) => {
  try {
    const scopedVMs = (await nsx.search.query<
      VMwareNSXVirtualMachine
    >({
      "query":
        `resource_type:VirtualMachine AND tags.scope:${scope} AND power_state:VM_RUNNING`,
    }, false).catch((error: HTTPError) => {
      logger.error(
        `nam-firewall-exposed-vms-ssi: Failed to get tagged VMs from '${nsx.getHostname()}': ${error.message}`,
        {
          component: "nsx.service",
          method: "getVMsFromLM",
          error: isDevMode() ? error : error?.message,
        },
      );
      throw error;
    }) as VMwareNSXResponse<VMwareNSXVirtualMachine>).results;

    const taggedVMs = scopedVMs.filter((vm) =>
      vm.tags?.some((t) => t.scope === scope && t.tag === tag)
    );

    return taggedVMs;
  } catch (error) {
    throw error;
  }
};

const getGroupMemberIPs = async (
  nsx: VMwareNSXDriver,
  policyPath: string,
) => {
  try {
    const ipAddressUrl = `/policy/api/v1${policyPath}/members/ip-addresses`;
    const groupMemberIps: string[] = (await nsx.getByUrl<
      VMwareNSXResponse<string>
    >(
      ipAddressUrl,
    ).catch(
      (error: HTTPError) => {
        logger.error(
          `viti-network-policies-ssi: Could not retrieve group member ip addresses from NSX for policy path ${policyPath} ${nsx?.getHostname()} due to ${error.message}`,
          {
            component: "nsx.service",
            method: "getGroupMemberIPs",
            error: isDevMode() ? error : error.message,
          },
        );
        throw error;
      },
    ) as VMwareNSXResponse<string>)?.results;

    return groupMemberIps;
  } catch (error) {
    throw error;
  }
};

const extractVirtualMachineIPs = async (
  nsx: VMwareNSXDriver,
  vm: VMwareNSXVirtualMachine,
) => {
  const virtualInterfaces = await nsx.virtualInterfaces
    .getVirtualInterfaces({
      owner_vm_id: vm.external_id,
    });

  const ips = filterLinkLocal(
    virtualInterfaces.results
      .flatMap((vif) => vif.ip_address_info ?? [])
      .flatMap((info) => info.ip_addresses ?? []),
  );

  return ips;
};
