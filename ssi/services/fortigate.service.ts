import {
  FortiOSDriver,
  FortiOSFirewallAddress,
  FortiOSFirewallAddress6,
  FortiOSFirewallAddrGrp,
  FortiOSFirewallAddrGrp6,
  FortiOSResponse,
  FortiOSSystemVDOM,
  HTTPError,
  isDevMode,
  NAMFortiOSVdom,
} from "@norskhelsenett/zeniki";
import logger from "../loggers/logger.ts";

export interface AddressObjects {
  IPv4: Record<string, FortiOSFirewallAddress>;
  IPv6: Record<string, FortiOSFirewallAddress6>;
}

export const deployIPv4 = async (
  firewall: FortiOSDriver,
  addressObjects: AddressObjects,
  vdom: NAMFortiOSVdom,
) => {
  try {
    const currentMemberNames = Object.values(addressObjects.IPv4).map((obj) => {
      return { name: obj.name };
    });

    for (const [name, object] of Object.entries(addressObjects.IPv4)) {
      const existingAddress = await firewall.address.getAddress(
        object.name,
        { vdom: vdom.name },
      ).catch((error: HTTPError) => {
        if (error.response?.status === 404) {
          return undefined;
        }
        logger.error(
          `dcn-viti-network-policies-ssi: Failed to get IPV4 address object '${name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
          {
            component: "fortios.service",
            method: "deployExposedAddresses",
            error: isDevMode() ? error : error?.message,
          },
        );
        throw error;
      });

      if (!existingAddress) {
        await firewall.address.addAddress(
          object,
          { vdom: vdom.name },
        ).then(() => {
          logger.info(
            `dcn-viti-network-policies-ssi: Created IPv4 address object '${object.name}' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
          );
        }).catch((error: HTTPError) => {
          logger.error(
            `dcn-viti-network-policies-ssi: Failed to create address object '${name}' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployExposedAddresses",
              error: isDevMode() ? error : error?.message,
            },
          );
          throw error;
        });
      }
    }

    const addressGroupResponse = (await firewall.addrgrp.getAddressGroup(
      "grp_internet_exposed_vms",
      { vdom: vdom.name },
    ).catch((error: HTTPError) => {
      if (error.response?.status === 404) {
        logger.debug(
          `dcn-viti-network-policies-ssi: Address object '${name}' not found in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
        );
        return undefined;
      }
      logger.error(
        `dcn-viti-network-policies-ssi: Failed to get address group for address object '${name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
        {
          component: "fortios.service",
          method: "deployExposedAddresses",
          error: isDevMode() ? error : error?.message,
        },
      );
      throw error;
    }) as FortiOSResponse<FortiOSFirewallAddrGrp>)
      .results;

    const addressGroup = addressGroupResponse.find((grp) =>
      grp.name === "grp_internet_exposed_vms"
    );

    if (!addressGroup) {
      await firewall.addrgrp.addAddressGroup(
        {
          name: "grp_internet_exposed_vms",
          member: currentMemberNames,
        },
        { vdom: vdom.name },
      ).then(() => {
        logger.info(
          `dcn-viti-network-policies-ssi: Created address group 'grp_internet_exposed_vms' on Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
        );
      }).catch((error: HTTPError) => {
        logger.error(
          `dcn-viti-network-policies-ssi: Failed to create address group 'grp_internet_exposed_vms' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
          {
            component: "fortios.service",
            method: "deployExposedAddresses",
            error: isDevMode() ? error : error?.message,
          },
        );
        throw error;
      });
    } else {
      const newExposedAddresses = currentMemberNames.filter((newMember) =>
        !addressGroup.member?.some((existingMember) =>
          existingMember.name === newMember.name
        )
      );

      const removedExposedAddresses =
        addressGroup.member?.filter((existingMember) =>
          !currentMemberNames.some((newMember) =>
            newMember.name === existingMember.name
          )
        ) ?? [];

      if (
        newExposedAddresses.length > 0 || removedExposedAddresses.length > 0
      ) {
        // Update existing address group
        addressGroup.member = currentMemberNames;
        await firewall.addrgrp.updateAddressGroup(
          "grp_internet_exposed_vms",
          addressGroup,
          { vdom: vdom.name },
        ).then(() => {
          logger.info(
            `dcn-viti-network-policies-ssi: Updated address group 'grp_internet_exposed_vms' on Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
            {
              name: addressGroup.name,
              type: "UPDATE",
              src: {
                system: "nsx",
              },
              dst: {
                system: "fortigate",
                server: firewall.getHostname(),
                options: { vdom: vdom.name },
              },
              changes: {
                added: newExposedAddresses.map((added) => added.name),
                removed: removedExposedAddresses.map((removed) => removed.name),
              },
            },
          );
        }).catch((error: HTTPError) => {
          logger.error(
            `dcn-viti-network-policies-ssi: Failed to update address group 'grp_internet_exposed_vms' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployExposedAddresses",
              error: isDevMode() ? error : error?.message,
            },
          );
          throw error;
        });

        for (const address of removedExposedAddresses) {
          if (await addressInUse(firewall, vdom, address)) {
            logger.info(
              `dcn-viti-network-policies-ssi: Address object '${address.name}' is still in use on Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}', skipping deletion.`,
            );
          } else {
            await firewall.address.deleteAddress(
              address.name,
              { vdom: vdom.name },
            ).then(() => {
              logger.info(
                `dcn-viti-network-policies-ssi: Deleted IPv4 address object '${address.name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
              );
            }).catch((error: HTTPError) => {
              logger.error(
                `dcn-viti-network-policies-ssi: Failed to delete address object '${address.name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
                {
                  component: "fortios.service",
                  method: "deployExposedAddresses",
                  error: isDevMode() ? error : error?.message,
                },
              );
              throw error;
            });
          }
        }
      }
    }
  } catch (error) {
    throw error;
  }
};

export const deployIPv6 = async (
  firewall: FortiOSDriver,
  addressObjects: AddressObjects,
  vdom: NAMFortiOSVdom,
) => {
  try {
    const currentMemberNames = Object.values(addressObjects.IPv6).map((obj) => {
      return { name: obj.name };
    });

    for (const [name, object] of Object.entries(addressObjects.IPv6)) {
      const existingAddress = await firewall.address6.getAddress6(
        object.name,
        { vdom: vdom.name },
      ).catch((error: HTTPError) => {
        if (error.response?.status === 404) {
          return undefined;
        }
        logger.error(
          `dcn-viti-network-policies-ssi: Failed to get IPV6 address object '${name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
          {
            component: "fortios.service",
            method: "deployExposedAddresses",
            error: isDevMode() ? error : error?.message,
          },
        );
        throw error;
      });

      if (!existingAddress) {
        await firewall.address6.addAddress6(
          object,
          { vdom: vdom.name },
        ).then(() => {
          logger.info(
            `dcn-viti-network-policies-ssi: Created IPv6 address object '${object.name}' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
          );
        }).catch((error: HTTPError) => {
          logger.error(
            `dcn-viti-network-policies-ssi: Failed to create address object '${name}' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployExposedAddresses",
              error: isDevMode() ? error : error?.message,
            },
          );
          throw error;
        });
      }
    }

    const addressGroupResponse = (await firewall.addrgrp6.getAddressGroup6(
      "grp6_internet_exposed_vms",
      { vdom: vdom.name },
    ).catch((error: HTTPError) => {
      if (error.response?.status === 404) {
        logger.debug(
          `dcn-viti-network-policies-ssi: Address object '${name}' not found in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
        );
        return undefined;
      }
      logger.error(
        `dcn-viti-network-policies-ssi: Failed to get address group for address object '${name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
        {
          component: "fortios.service",
          method: "deployExposedAddresses",
          error: isDevMode() ? error : error?.message,
        },
      );
      throw error;
    }) as FortiOSResponse<FortiOSFirewallAddrGrp6>)
      .results;

    const addressGroup = addressGroupResponse.find((grp) =>
      grp.name === "grp6_internet_exposed_vms"
    );

    if (!addressGroup) {
      await firewall.addrgrp6.addAddressGroup6(
        {
          name: "grp6_internet_exposed_vms",
          member: currentMemberNames,
        },
        { vdom: vdom.name },
      ).then(() => {
        logger.info(
          `dcn-viti-network-policies-ssi: Created address group 'grp6_internet_exposed_vms' on Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
        );
      }).catch((error: HTTPError) => {
        logger.error(
          `dcn-viti-network-policies-ssi: Failed to create address group 'grp6_internet_exposed_vms' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
          {
            component: "fortios.service",
            method: "deployExposedAddresses",
            error: isDevMode() ? error : error?.message,
          },
        );
        throw error;
      });
    } else {
      const newExposedAddresses = currentMemberNames.filter((newMember) =>
        !addressGroup.member?.some((existingMember) =>
          existingMember.name === newMember.name
        )
      );

      const removedExposedAddresses = addressGroup.member?.filter((
        existingMember,
      ) =>
        !currentMemberNames.some((newMember) =>
          newMember.name === existingMember.name
        )
      );

      if (
        newExposedAddresses.length > 0 || removedExposedAddresses.length > 0
      ) {
        // Update existing address group
        addressGroup.member = currentMemberNames;
        await firewall.addrgrp6.updateAddressGroup6(
          "grp6_internet_exposed_vms",
          addressGroup,
          { vdom: vdom.name },
        ).then(() => {
          logger.info(
            `dcn-viti-network-policies-ssi: Updated address group 'grp6_internet_exposed_vms' on Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
            {
              name: addressGroup.name,
              type: "UPDATE",
              src: {
                system: "nsx",
              },
              dst: {
                system: "fortigate",
                server: firewall.getHostname(),
                options: { vdom: vdom.name },
              },
              changes: {
                added: newExposedAddresses.map((added) => added.name),
                removed: removedExposedAddresses.map((removed) => removed.name),
              },
            },
          );
        }).catch((error: HTTPError) => {
          logger.error(
            `dcn-viti-network-policies-ssi: Failed to update address group 'grp6_internet_exposed_vms' in Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
            {
              component: "fortios.service",
              method: "deployExposedAddresses",
              error: isDevMode() ? error : error?.message,
            },
          );
          throw error;
        });

        for (const address of removedExposedAddresses) {
          if (await address6InUse(firewall, vdom, address)) {
            logger.info(
              `dcn-viti-network-policies-ssi: Address object '${address.name}' is still in use on Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}', skipping deletion.`,
            );
          } else {
            await firewall.address6.deleteAddress6(
              address.name,
              { vdom: vdom.name },
            ).then(() => {
              logger.info(
                `dcn-viti-network-policies-ssi: Deleted IPv6 address object '${address.name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
              );
            }).catch((error: HTTPError) => {
              logger.error(
                `dcn-viti-network-policies-ssi: Failed to delete address object '${address.name}' from Fortigate '${firewall.getHostname()}' VDOM '${vdom.name}'`,
                {
                  component: "fortios.service",
                  method: "deployExposedAddresses",
                  error: isDevMode() ? error : error?.message,
                },
              );
              throw error;
            });
          }
        }
      }
    }
  } catch (error) {
    throw error;
  }
};

export const addressInUse = async (
  firewall: FortiOSDriver,
  vdom: FortiOSSystemVDOM,
  address: { name: string },
): Promise<boolean> => {
  const currentAddress = (await firewall.address.getAddress(
    address.name,
    { with_meta: 1, vdom: vdom.name },
  ).catch(
    (error: HTTPError) => {
      logger.error(
        `dcn-viti-network-policies-ssi: Could not retrieve IPv6 address from firewall ${firewall.getHostname()} due to ${error.message}`,
        {
          component: "ssi.utils",
          method: "addressInUse",
          error: isDevMode() ? error : error.message,
        },
      );
      throw error;
    },
  )).results[0];

  return currentAddress?.q_ref !== 0;
};

export const address6InUse = async (
  firewall: FortiOSDriver,
  vdom: FortiOSSystemVDOM,
  address: { name: string },
): Promise<boolean> => {
  const currentAddress = (await firewall.address6.getAddress6(
    address.name,
    { with_meta: 1, vdom: vdom.name },
  ).catch((error: HTTPError) => {
    logger.error(
      `dcn-viti-network-policies-ssi: Could not retrieve IPv6 address from firewall ${firewall.getHostname()} due to ${error.message}`,
      {
        component: "ssi.utils",
        method: "address6InUse",
        error: isDevMode() ? error : error.message,
      },
    );
    throw error;
  })).results[0];

  return currentAddress?.q_ref !== 0;
};
