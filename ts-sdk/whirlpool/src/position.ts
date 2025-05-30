import type { Position, PositionBundle } from "@orca-so/whirlpools-client";
import {
  decodePosition,
  decodePositionBundle,
  fetchAllPositionWithFilter,
  getBundledPositionAddress,
  getPositionAddress,
  getPositionBundleAddress,
  positionWhirlpoolFilter,
} from "@orca-so/whirlpools-client";
import { _POSITION_BUNDLE_SIZE } from "@orca-so/whirlpools-core";
import { getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type {
  Account,
  Address,
  GetMultipleAccountsApi,
  GetProgramAccountsApi,
  GetTokenAccountsByOwnerApi,
  Rpc,
} from "@solana/kit";
import { assertAccountExists, getBase64Encoder } from "@solana/kit";
import { fetchMultipleAccountsBatched } from "./utils";

/**
 * Represents a Position account.
 */
export type HydratedPosition = Account<Position> & {
  isPositionBundle: false;
};

/**
 * Represents a Position Bundle account including its associated positions.
 */
export type HydratedPositionBundle = Account<PositionBundle> & {
  positions: Account<Position>[];
  isPositionBundle: true;
};

/**
 * Represents either a Position or Position Bundle account.
 */
export type PositionOrBundle = HydratedPosition | HydratedPositionBundle;

/**
 * Represents a decoded Position or Position Bundle account.
 * Includes the token program address associated with the position.
 */
export type PositionData = PositionOrBundle & {
  /** The token program associated with the position (either TOKEN_PROGRAM_ADDRESS or TOKEN_2022_PROGRAM_ADDRESS). */
  tokenProgram: Address;
};

function getPositionInBundleAddresses(
  positionBundle: PositionBundle,
): Promise<Address>[] {
  const buffer = Buffer.from(positionBundle.positionBitmap);
  const positions: Promise<Address>[] = [];
  for (let i = 0; i < _POSITION_BUNDLE_SIZE(); i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    if (buffer[byteIndex] & (1 << bitIndex)) {
      positions.push(
        getBundledPositionAddress(positionBundle.positionBundleMint, i).then(
          (x) => x[0],
        ),
      );
    }
  }
  return positions;
}

/**
 * Fetches all positions owned by a given wallet in the Orca Whirlpools.
 * It looks for token accounts owned by the wallet using both the TOKEN_PROGRAM_ADDRESS and TOKEN_2022_PROGRAM_ADDRESS.
 * For token accounts holding exactly 1 token (indicating a position or bundle), it fetches the corresponding position addresses,
 * decodes the accounts, and returns an array of position or bundle data.
 *
 * @param {SolanaRpc} rpc - The Solana RPC client used to fetch token accounts and multiple accounts.
 * @param {Address} owner - The wallet address whose positions you want to fetch.
 * @returns {Promise<PositionData[]>} - A promise that resolves to an array of decoded position data for the given owner.
 *
 * @example
 * import { fetchPositionsForOwner } from '@orca-so/whirlpools';
 * import { generateKeyPairSigner, createSolanaRpc, devnet } from '@solana/kit';
 *
 * const devnetRpc = createSolanaRpc(devnet('https://api.devnet.solana.com'));
 * const wallet = address("INSERT_WALLET_ADDRESS");
 *
 * const positions = await fetchPositionsForOwner(devnetRpc, wallet.address);
 */
export async function fetchPositionsForOwner(
  rpc: Rpc<GetTokenAccountsByOwnerApi & GetMultipleAccountsApi>,
  owner: Address,
): Promise<PositionData[]> {
  const [tokenAccounts, token2022Accounts] = await Promise.all([
    rpc
      .getTokenAccountsByOwner(
        owner,
        { programId: TOKEN_PROGRAM_ADDRESS },
        { encoding: "base64" },
      )
      .send(),
    rpc
      .getTokenAccountsByOwner(
        owner,
        { programId: TOKEN_2022_PROGRAM_ADDRESS },
        { encoding: "base64" },
      )
      .send(),
  ]);

  const encoder = getBase64Encoder();
  const decoder = getTokenDecoder();

  const potentialTokens = [...tokenAccounts.value, ...token2022Accounts.value]
    .map((x) => ({
      ...decoder.decode(encoder.encode(x.account.data[0])),
      tokenProgram: x.account.owner,
    }))
    .filter((x) => x.amount === 1n);

  const positionAddresses = await Promise.all(
    potentialTokens.map((x) => getPositionAddress(x.mint).then((x) => x[0])),
  );

  const positionBundleAddresses = await Promise.all(
    potentialTokens.map((x) =>
      getPositionBundleAddress(x.mint).then((x) => x[0]),
    ),
  );

  const positions = await fetchMultipleAccountsBatched(
    rpc,
    positionAddresses,
    decodePosition,
  );

  const positionBundles = await fetchMultipleAccountsBatched(
    rpc,
    positionBundleAddresses,
    decodePositionBundle,
  );

  const bundledPositionAddresses = await Promise.all(
    positionBundles
      .filter((x) => x.exists)
      .flatMap((x) => getPositionInBundleAddresses(x.data)),
  );

  const bundledPositions = (
    await fetchMultipleAccountsBatched(
      rpc,
      bundledPositionAddresses,
      decodePosition,
    )
  )
    .filter((x) => x.exists)
    .map((x) => {
      assertAccountExists(x);
      return x;
    });

  const bundledPositionMap = bundledPositions.reduce((acc, x) => {
    const current = acc.get(x.data.positionMint) ?? [];
    return acc.set(x.data.positionMint, [...current, x]);
  }, new Map<Address, Account<Position>[]>());

  const positionsOrBundles: PositionData[] = [];

  for (let i = 0; i < potentialTokens.length; i++) {
    const position = positions[i];
    const positionBundle = positionBundles[i];
    const token = potentialTokens[i];

    if (position.exists) {
      positionsOrBundles.push({
        ...position,
        tokenProgram: token.tokenProgram,
        isPositionBundle: false,
      });
    }

    if (positionBundle.exists) {
      const positions =
        bundledPositionMap.get(positionBundle.data.positionBundleMint) ?? [];
      positionsOrBundles.push({
        ...positionBundle,
        positions,
        tokenProgram: token.tokenProgram,
        isPositionBundle: true,
      });
    }
  }

  return positionsOrBundles;
}

/**
 * Fetches all positions for a given Whirlpool.
 *
 * @param {SolanaRpc} rpc - The Solana RPC client used to fetch positions.
 * @param {Address} whirlpool - The address of the Whirlpool.
 * @returns {Promise<HydratedPosition[]>} - A promise that resolves to an array of hydrated positions.
 *
 * @example
 * import { fetchPositionsInWhirlpool } from '@orca-so/whirlpools';
 * import { createSolanaRpc, devnet, address } from '@solana/kit';
 *
 * const devnetRpc = createSolanaRpc(devnet('https://api.devnet.solana.com'));
 *
 * const whirlpool = address("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
 * const positions = await fetchPositionsInWhirlpool(devnetRpc, whirlpool);
 */
export async function fetchPositionsInWhirlpool(
  rpc: Rpc<GetProgramAccountsApi>,
  whirlpool: Address,
): Promise<HydratedPosition[]> {
  const positions = await fetchAllPositionWithFilter(
    rpc,
    positionWhirlpoolFilter(whirlpool),
  );
  return positions.map((x) => ({
    ...x,
    isPositionBundle: false,
  }));
}
