import { z } from "zod";
import {
  GovernanceError,
  setOutboundDestinationInputSchema,
  type OutboundDestination,
  type SetOutboundDestinationInput,
} from "../domain/index.js";
import type { OutboundDestinationStore } from "../storage/outbound-destination-store.js";
import type { ProfileStore } from "../storage/profile-store.js";

export interface DestinationService {
  getCurrent(profileId: string): OutboundDestination | null;
  set(input: SetOutboundDestinationInput): OutboundDestination;
  disable(profileId: string): OutboundDestination;
}

export type DestinationServiceIdPrefix = "destination" | "audit";

export interface DestinationServiceDependencies {
  destinationStore: OutboundDestinationStore;
  profileStore: Pick<ProfileStore, "getProfile">;
  now: () => string;
  newId: (prefix: DestinationServiceIdPrefix) => string;
}

const profileIdSchema = z.string().trim().min(1).max(200);

const profileOrThrow = (
  profileStore: Pick<ProfileStore, "getProfile">,
  profileId: string,
  requireEnabled: boolean,
) => {
  const profile = profileStore.getProfile(profileId);
  if (!profile) {
    throw new GovernanceError("validation_failed", "Profile not found");
  }
  if (requireEnabled && profile.status === "disabled") {
    throw new GovernanceError("profile_disabled", "Profile is disabled");
  }
  return profile;
};

export const createDestinationService = ({
  destinationStore,
  profileStore,
  now,
  newId,
}: DestinationServiceDependencies): DestinationService => ({
  getCurrent(profileId: string): OutboundDestination | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    return destinationStore.getCurrent(parsedProfileId);
  },

  set(input: SetOutboundDestinationInput): OutboundDestination {
    const parsed = setOutboundDestinationInputSchema.parse(input);
    profileOrThrow(profileStore, parsed.profileId, true);
    const current = destinationStore.getCurrent(parsed.profileId);
    const timestamp = now();

    return destinationStore.set({
      destination: {
        id: current?.id ?? newId("destination"),
        ...parsed,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      audit: {
        id: newId("audit"),
        createdAt: timestamp,
      },
    });
  },

  disable(profileId: string): OutboundDestination {
    const parsedProfileId = profileIdSchema.parse(profileId);
    profileOrThrow(profileStore, parsedProfileId, false);
    const timestamp = now();

    return destinationStore.disable({
      profileId: parsedProfileId,
      createdAt: timestamp,
      updatedAt: timestamp,
      audit: {
        id: newId("audit"),
        createdAt: timestamp,
      },
    });
  },
});
