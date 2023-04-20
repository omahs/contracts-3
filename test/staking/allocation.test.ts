import { expect } from 'chai'
import { constants, BigNumber, PopulatedTransaction, ethers } from 'ethers'

import { Curation } from '../../build/types/Curation'
import { EpochManager } from '../../build/types/EpochManager'
import { GraphToken } from '../../build/types/GraphToken'
import { Staking } from '../../build/types/Staking'
import { LibExponential } from '../../build/types/LibExponential'

import { NetworkFixture } from '../lib/fixtures'
import {
  advanceToNextEpoch,
  deriveChannelKey,
  getAccounts,
  randomHexBytes,
  toBN,
  toGRT,
  Account,
  advanceEpochs,
} from '../lib/testHelpers'

const { AddressZero } = constants

const MAX_PPM = toBN('1000000')
const toPercentage = (ppm: BigNumber) => ppm.mul(100).div(MAX_PPM).toNumber()

enum AllocationState {
  Null,
  Active,
  Closed,
}

describe('Staking:Allocation', () => {
  let me: Account
  let governor: Account
  let indexer: Account
  let slasher: Account
  let assetHolder: Account

  let fixture: NetworkFixture

  let curation: Curation
  let epochManager: EpochManager
  let grt: GraphToken
  let staking: Staking
  let libExponential: LibExponential

  // Test values

  const indexerTokens = toGRT('1000')
  const tokensToStake = toGRT('100')
  const tokensToAllocate = toGRT('100')
  const tokensToCollect = toGRT('100')
  const subgraphDeploymentID = randomHexBytes()
  const channelKey = deriveChannelKey()
  const allocationID = channelKey.address
  const anotherChannelKey = deriveChannelKey()
  const anotherAllocationID = anotherChannelKey.address
  const metadata = randomHexBytes(32)
  const poi = randomHexBytes()

  // Helpers

  const allocate = async (tokens: BigNumber, _allocationID?: string, _proof?: string) => {
    return staking
      .connect(indexer.signer)
      .allocateFrom(
        indexer.address,
        subgraphDeploymentID,
        tokens,
        _allocationID ?? allocationID,
        metadata,
        _proof ?? (await channelKey.generateProof(indexer.address)),
      )
  }

  const shouldAllocate = async (tokensToAllocate: BigNumber) => {
    // Advance epoch to prevent epoch jumping mid test
    await advanceToNextEpoch(epochManager)

    // Before state
    const beforeStake = await staking.stakes(indexer.address)

    // Allocate
    const currentEpoch = await epochManager.currentEpoch()
    const tx = allocate(tokensToAllocate)
    await expect(tx)
      .emit(staking, 'AllocationCreated')
      .withArgs(
        indexer.address,
        subgraphDeploymentID,
        currentEpoch,
        tokensToAllocate,
        allocationID,
        metadata,
      )

    // After state
    const afterStake = await staking.stakes(indexer.address)
    const afterAlloc = await staking.getAllocation(allocationID)

    // Stake updated
    expect(afterStake.tokensAllocated).eq(beforeStake.tokensAllocated.add(tokensToAllocate))
    // Allocation updated
    expect(afterAlloc.indexer).eq(indexer.address)
    expect(afterAlloc.subgraphDeploymentID).eq(subgraphDeploymentID)
    expect(afterAlloc.tokens).eq(tokensToAllocate)
    expect(afterAlloc.createdAtEpoch).eq(currentEpoch)
    expect(afterAlloc.collectedFees).eq(toGRT('0'))
    expect(afterAlloc.closedAtEpoch).eq(toBN('0'))
  }

  // This function tests collect with state updates
  const shouldCollect = async (
    tokensToCollect: BigNumber,
    _allocationID?: string,
  ): Promise<{ queryRebates: BigNumber; queryFeesBurnt: BigNumber }> => {
    const alloID = _allocationID ?? allocationID
    // Should have a particular state before claiming
    expect(await staking.getAllocationState(alloID)).to.be.oneOf([
      AllocationState.Active,
      AllocationState.Closed,
    ])

    // Before state
    const beforeTokenSupply = await grt.totalSupply()
    const beforePool = await curation.pools(subgraphDeploymentID)
    const beforeAlloc = await staking.getAllocation(alloID)
    const beforeIndexerBalance = await grt.balanceOf(indexer.address)

    // Advance blocks to get the allocation in epoch where it can be closed
    await advanceToNextEpoch(epochManager)

    // Collect fees and calculate expected results
    let rebateFees = tokensToCollect
    const protocolPercentage = await staking.protocolPercentage()
    const protocolFees = rebateFees.mul(protocolPercentage).div(MAX_PPM)
    rebateFees = rebateFees.sub(protocolFees)

    const curationPercentage = await staking.curationPercentage()
    const curationFees = rebateFees.mul(curationPercentage).div(MAX_PPM)
    rebateFees = rebateFees.sub(curationFees)

    const queryFees = tokensToCollect.sub(protocolFees).sub(curationFees)

    const [alphaNumerator, alphaDenominator, lambdaNumerator, lambdaDenominator] =
      await Promise.all([
        staking.alphaNumerator(),
        staking.alphaDenominator(),
        staking.lambdaNumerator(),
        staking.lambdaDenominator(),
      ])
    const accumulatedRebates = await libExponential.exponentialRebates(
      queryFees.add(beforeAlloc.collectedFees),
      beforeAlloc.tokens,
      alphaNumerator,
      alphaDenominator,
      lambdaNumerator,
      lambdaDenominator,
    )
    let queryRebates = beforeAlloc.distributedRebates.gt(accumulatedRebates)
      ? BigNumber.from(0)
      : accumulatedRebates.sub(beforeAlloc.distributedRebates)
    queryRebates = queryRebates.gt(queryFees) ? queryFees : queryRebates
    const queryFeesBurnt = queryFees.sub(queryRebates)

    // Collect tokens from allocation
    const tx = staking.connect(assetHolder.signer).collect(tokensToCollect, alloID)
    await expect(tx)
      .emit(staking, 'RebateCollected')
      .withArgs(
        assetHolder.address,
        indexer.address,
        subgraphDeploymentID,
        alloID,
        await epochManager.currentEpoch(),
        tokensToCollect,
        protocolFees,
        curationFees,
        queryFees,
        queryRebates,
        BigNumber.from('0'), // Delegator rewards tested separately
      )

    // After state
    const afterTokenSupply = await grt.totalSupply()
    const afterPool = await curation.pools(subgraphDeploymentID)
    const afterAlloc = await staking.getAllocation(alloID)
    const afterIndexerBalance = await grt.balanceOf(indexer.address)

    // Check that protocol fees are burnt
    expect(afterTokenSupply).eq(beforeTokenSupply.sub(protocolFees).sub(queryFeesBurnt))

    // Check that collected tokens are correctly distributed for rebating + tax + curators
    // tokensToCollect = queryFees + protocolFees + curationFees
    expect(tokensToCollect).eq(queryFees.add(protocolFees).add(curationFees))

    // Check that rebated fees + fees burnt equals collected tokens after tax and curator fee
    // queryFees = queryRebates + queryFeesBurnt
    expect(queryFees).eq(queryRebates.add(queryFeesBurnt))

    // Check that curation reserves increased for the SubgraphDeployment
    expect(afterPool.tokens).eq(beforePool.tokens.add(curationFees))

    // Verify allocation is updated and allocation is not cleaned
    expect(afterAlloc.tokens).eq(beforeAlloc.tokens)
    expect(afterAlloc.createdAtEpoch).eq(beforeAlloc.createdAtEpoch)
    expect(afterAlloc.closedAtEpoch).eq(beforeAlloc.closedAtEpoch)
    expect(afterAlloc.collectedFees).eq(beforeAlloc.collectedFees.add(rebateFees))
    expect(afterAlloc.collectedFees).eq(queryFees.add(beforeAlloc.collectedFees))
    expect(afterAlloc.distributedRebates).eq(beforeAlloc.distributedRebates.add(queryRebates))

    // // Funds distributed to indexer
    const restake = (await staking.rewardsDestination(indexer.address)) === AddressZero
    if (restake) {
      expect(afterIndexerBalance).eq(beforeIndexerBalance)
    } else {
      expect(afterIndexerBalance).eq(beforeIndexerBalance.add(queryRebates))
    }

    return { queryRebates, queryFeesBurnt }
  }

  const shouldCollectMultiple = async (collections: BigNumber[]) => {
    // Perform the multiple collections on currently open allocation
    const totalTokensToCollect = collections.reduce((a, b) => a.add(b), BigNumber.from(0))
    let rebatedAmountMultiple = BigNumber.from(0)
    for (const collect of collections) {
      rebatedAmountMultiple = rebatedAmountMultiple.add((await shouldCollect(collect)).queryRebates)
    }

    // Reset rebates state by closing allocation, advancing epoch and opening a new allocation
    await staking.connect(indexer.signer).closeAllocation(allocationID, poi)
    await advanceToNextEpoch(epochManager)
    await allocate(
      tokensToAllocate,
      anotherAllocationID,
      await anotherChannelKey.generateProof(indexer.address),
    )

    // Collect `tokensToCollect` with a single voucher
    const rebatedAmountFull = (await shouldCollect(totalTokensToCollect, anotherAllocationID))
      .queryRebates

    // Check rebated amounts match
    expect(rebatedAmountMultiple).to.equal(rebatedAmountFull)
  }
  // -- Tests --

  before(async function () {
    ;[me, governor, indexer, slasher, assetHolder] = await getAccounts()

    fixture = new NetworkFixture()
    ;({ curation, epochManager, grt, staking, libExponential } = await fixture.load(
      governor.signer,
      slasher.signer,
    ))

    // Give some funds to the indexer and approve staking contract to use funds on indexer behalf
    await grt.connect(governor.signer).mint(indexer.address, indexerTokens)
    await grt.connect(indexer.signer).approve(staking.address, indexerTokens)

    // Allow the asset holder
    await staking.connect(governor.signer).setAssetHolder(assetHolder.address, true)
  })

  beforeEach(async function () {
    await fixture.setUp()
  })

  afterEach(async function () {
    await fixture.tearDown()
  })

  describe('operators', function () {
    it('should set operator', async function () {
      // Before state
      const beforeOperator = await staking.operatorAuth(indexer.address, me.address)

      // Set operator
      const tx = staking.connect(indexer.signer).setOperator(me.address, true)
      await expect(tx).emit(staking, 'SetOperator').withArgs(indexer.address, me.address, true)

      // After state
      const afterOperator = await staking.operatorAuth(indexer.address, me.address)

      // State updated
      expect(beforeOperator).eq(false)
      expect(afterOperator).eq(true)
    })

    it('should unset operator', async function () {
      await staking.connect(indexer.signer).setOperator(me.address, true)

      // Before state
      const beforeOperator = await staking.operatorAuth(indexer.address, me.address)

      // Set operator
      const tx = staking.connect(indexer.signer).setOperator(me.address, false)
      await expect(tx).emit(staking, 'SetOperator').withArgs(indexer.address, me.address, false)

      // After state
      const afterOperator = await staking.operatorAuth(indexer.address, me.address)

      // State updated
      expect(beforeOperator).eq(true)
      expect(afterOperator).eq(false)
    })
  })

  describe('rewardsDestination', function () {
    it('should set rewards destination', async function () {
      // Before state
      const beforeDestination = await staking.rewardsDestination(indexer.address)

      // Set
      const tx = staking.connect(indexer.signer).setRewardsDestination(me.address)
      await expect(tx).emit(staking, 'SetRewardsDestination').withArgs(indexer.address, me.address)

      // After state
      const afterDestination = await staking.rewardsDestination(indexer.address)

      // State updated
      expect(beforeDestination).eq(AddressZero)
      expect(afterDestination).eq(me.address)

      // Must be able to set back to zero
      await staking.connect(indexer.signer).setRewardsDestination(AddressZero)
      expect(await staking.rewardsDestination(indexer.address)).eq(AddressZero)
    })
  })

  /**
   * Allocate
   */
  describe('allocate', function () {
    it('reject allocate with invalid allocationID', async function () {
      const tx = staking
        .connect(indexer.signer)
        .allocateFrom(
          indexer.address,
          subgraphDeploymentID,
          tokensToAllocate,
          AddressZero,
          metadata,
          randomHexBytes(20),
        )
      await expect(tx).revertedWith('!alloc')
    })

    it('reject allocate if no tokens staked', async function () {
      const tx = allocate(toBN('1'))
      await expect(tx).revertedWith('!capacity')
    })

    it('reject allocate zero tokens if no minimum stake', async function () {
      const tx = allocate(toBN('0'))
      await expect(tx).revertedWith('!minimumIndexerStake')
    })

    context('> when staked', function () {
      beforeEach(async function () {
        await staking.connect(indexer.signer).stake(tokensToStake)
      })

      it('reject allocate more than available tokens', async function () {
        const tokensOverCapacity = tokensToStake.add(toBN('1'))
        const tx = allocate(tokensOverCapacity)
        await expect(tx).revertedWith('!capacity')
      })

      it('should allocate', async function () {
        await shouldAllocate(tokensToAllocate)
      })

      it('should allow allocation of zero tokens', async function () {
        const zeroTokens = toGRT('0')
        const tx = allocate(zeroTokens)
        await tx
      })

      it('should allocate on behalf of indexer', async function () {
        const proof = await channelKey.generateProof(indexer.address)

        // Reject to allocate if the address is not operator
        const tx1 = staking
          .connect(me.signer)
          .allocateFrom(
            indexer.address,
            subgraphDeploymentID,
            tokensToAllocate,
            allocationID,
            metadata,
            proof,
          )
        await expect(tx1).revertedWith('!auth')

        // Should allocate if given operator auth
        await staking.connect(indexer.signer).setOperator(me.address, true)
        await staking
          .connect(me.signer)
          .allocateFrom(
            indexer.address,
            subgraphDeploymentID,
            tokensToAllocate,
            allocationID,
            metadata,
            proof,
          )
      })

      it('reject allocate reusing an allocation ID', async function () {
        const someTokensToAllocate = toGRT('10')
        await shouldAllocate(someTokensToAllocate)
        const tx = allocate(someTokensToAllocate)
        await expect(tx).revertedWith('!null')
      })

      describe('reject allocate on invalid proof', function () {
        it('invalid message', async function () {
          const invalidProof = await channelKey.generateProof(randomHexBytes(20))
          const tx = staking
            .connect(indexer.signer)
            .allocateFrom(
              indexer.address,
              subgraphDeploymentID,
              tokensToAllocate,
              indexer.address,
              metadata,
              invalidProof,
            )
          await expect(tx).revertedWith('!proof')
        })

        it('invalid proof signature format', async function () {
          const tx = staking
            .connect(indexer.signer)
            .allocateFrom(
              indexer.address,
              subgraphDeploymentID,
              tokensToAllocate,
              indexer.address,
              metadata,
              randomHexBytes(32),
            )
          await expect(tx).revertedWith('ECDSA: invalid signature length')
        })
      })
    })
  })

  /**
   * Collect
   */
  describe('collect', function () {
    beforeEach(async function () {
      // Create the allocation
      await staking.connect(indexer.signer).stake(tokensToStake)
      await allocate(tokensToAllocate)

      // Add some signal to the subgraph to enable curation fees
      const tokensToSignal = toGRT('100')
      await grt.connect(governor.signer).mint(me.address, tokensToSignal)
      await grt.connect(me.signer).approve(curation.address, tokensToSignal)
      await curation.connect(me.signer).mint(subgraphDeploymentID, tokensToSignal, 0)

      // Fund asset holder wallet
      const tokensToFund = toGRT('100000')
      await grt.connect(governor.signer).mint(assetHolder.address, tokensToFund)
      await grt.connect(assetHolder.signer).approve(staking.address, tokensToFund)
    })

    // * Test with different curation fees and protocol tax
    for (const params of [
      { curationPercentage: toBN('0'), protocolPercentage: toBN('0') },
      { curationPercentage: toBN('0'), protocolPercentage: toBN('100000') },
      { curationPercentage: toBN('200000'), protocolPercentage: toBN('0') },
      { curationPercentage: toBN('200000'), protocolPercentage: toBN('100000') },
    ]) {
      context(
        `> with ${toPercentage(params.curationPercentage)}% curationPercentage and ${toPercentage(
          params.protocolPercentage,
        )}% protocolPercentage`,
        async function () {
          beforeEach(async function () {
            // Set a protocol fee percentage
            await staking.connect(governor.signer).setProtocolPercentage(params.protocolPercentage)

            // Set a curation fee percentage
            await staking.connect(governor.signer).setCurationPercentage(params.curationPercentage)
          })

          it('should collect funds from asset holder (restake=true)', async function () {
            await shouldCollect(tokensToCollect)
          })

          it('should collect funds from asset holder (restake=false)', async function () {
            // Set a random rewards destination address
            await staking.connect(governor.signer).setRewardsDestination(me.address)
            await shouldCollect(tokensToCollect)
          })

          it('should collect funds on both active and closed allocations', async function () {
            // Collect from active allocation
            await shouldCollect(tokensToCollect)

            // Close allocation
            await staking.connect(indexer.signer).closeAllocation(allocationID, poi)

            // Collect from closed allocation
            await shouldCollect(tokensToCollect)
          })

          it('should collect zero tokens', async function () {
            await shouldCollect(toGRT('0'))
          })

          it('should allow multiple collections on the same allocation', async function () {
            // Collect `tokensToCollect` with 4 different vouchers
            // This can represent vouchers not necessarily from the same gateway
            const splitCollect = tokensToCollect.div(4)
            await shouldCollectMultiple(Array(4).fill(splitCollect))
          })

          it('should allow multiple collections on the same allocation (edge case 1: small then big)', async function () {
            // Collect `tokensToCollect` with 2 vouchers, one small and then one big
            const smallCollect = tokensToCollect.div(100)
            const bigCollect = tokensToCollect.sub(smallCollect)
            await shouldCollectMultiple([smallCollect, bigCollect])
          })

          it('should allow multiple collections on the same allocation (edge case 2: big then small)', async function () {
            // Collect `tokensToCollect` with 2 vouchers, one big and then one small
            const smallCollect = tokensToCollect.div(100)
            const bigCollect = tokensToCollect.sub(smallCollect)
            await shouldCollectMultiple([bigCollect, smallCollect])
          })
        },
      )
    }

    it('reject collect if invalid collection', async function () {
      const tx = staking.connect(indexer.signer).collect(tokensToCollect, AddressZero)
      await expect(tx).revertedWith('!alloc')
    })

    it('reject collect if allocation does not exist', async function () {
      const invalidAllocationID = randomHexBytes(20)
      const tx = staking.connect(assetHolder.signer).collect(tokensToCollect, invalidAllocationID)
      await expect(tx).revertedWith('!collect')
    })

    it('should resolve over-rebated scenarios correctly', async function () {
      // Set up a new allocation with `tokensToAllocate` staked
      await staking.connect(indexer.signer).stake(tokensToStake)
      await allocate(
        tokensToAllocate,
        anotherAllocationID,
        await anotherChannelKey.generateProof(indexer.address),
      )

      // Set initial rebate parameters, α = 0, λ = 1
      await staking.setRebateParameters(0, 1, 1, 1)

      // Collection amounts
      const firstTokensToCollect = tokensToAllocate.mul(8).div(10) // q1 < sij
      const secondTokensToCollect = tokensToAllocate.div(10) // q2 small amount, second collect should get "negative rebates"
      const thirdTokensToCollect = tokensToAllocate.mul(3) // q3 big amount so we get rebates again

      // First collection
      // Indexer gets 100% of the query fees due to α = 0
      const firstRebates = await shouldCollect(firstTokensToCollect, anotherAllocationID)
      expect(firstRebates.queryRebates).eq(firstTokensToCollect)
      expect(firstRebates.queryFeesBurnt).eq(BigNumber.from(0))

      // Update rebate parameters, α = 1, λ = 1
      await staking.setRebateParameters(1, 1, 1, 1)

      // Second collection
      // Indexer gets 0% of the query fees
      // Parameters changed so now they are over-rebated and should get "negative rebates", instead they get 0
      const secondRebates = await shouldCollect(secondTokensToCollect, anotherAllocationID)
      expect(secondRebates.queryRebates).eq(BigNumber.from(0))
      expect(secondRebates.queryFeesBurnt).eq(secondTokensToCollect)

      // Third collection
      // Previous collection plus this new one tip the balance and indexer is no longer over-rebated
      // They get rebates and burn again
      const thirdRebates = await shouldCollect(thirdTokensToCollect, anotherAllocationID)
      expect(thirdRebates.queryRebates).gt(BigNumber.from(0))
      expect(thirdRebates.queryFeesBurnt).gt(BigNumber.from(0))
    })

    it('should resolve under-rebated scenarios correctly', async function () {
      // Set up a new allocation with `tokensToAllocate` staked
      await staking.connect(indexer.signer).stake(tokensToStake)
      await allocate(
        tokensToAllocate,
        anotherAllocationID,
        await anotherChannelKey.generateProof(indexer.address),
      )

      // Set initial rebate parameters, α = 1, λ = 1
      await staking.setRebateParameters(1, 1, 1, 1)

      // Collection amounts
      const firstTokensToCollect = tokensToAllocate
      const secondTokensToCollect = tokensToAllocate
      const thirdTokensToCollect = tokensToAllocate.mul(50)

      // First collection
      // Indexer gets rebates and burn
      const firstRebates = await shouldCollect(firstTokensToCollect, anotherAllocationID)
      expect(firstRebates.queryRebates).gt(BigNumber.from(0))
      expect(firstRebates.queryFeesBurnt).gt(BigNumber.from(0))

      // Update rebate parameters, α = 0.1, λ = 1
      await staking.setRebateParameters(1, 10, 1, 1)

      // Second collection
      // Indexer gets 100% of the query fees
      // Parameters changed so now they are under-rebated and should get more than the available amount but we cap it
      const secondRebates = await shouldCollect(secondTokensToCollect, anotherAllocationID)
      expect(secondRebates.queryRebates).eq(secondTokensToCollect)
      expect(secondRebates.queryFeesBurnt).eq(BigNumber.from(0))

      // Third collection
      // Previous collection plus this new one tip the balance and indexer is no longer under-rebated
      // They get rebates and burn again
      const thirdRebates = await shouldCollect(thirdTokensToCollect, anotherAllocationID)
      expect(thirdRebates.queryRebates).gt(BigNumber.from(0))
      expect(thirdRebates.queryFeesBurnt).gt(BigNumber.from(0))
    })

    it('should get stuck under-rebated if alpha is changed to zero', async function () {
      // Set up a new allocation with `tokensToAllocate` staked
      await staking.connect(indexer.signer).stake(tokensToStake)
      await allocate(
        tokensToAllocate,
        anotherAllocationID,
        await anotherChannelKey.generateProof(indexer.address),
      )

      // Set initial rebate parameters, α = 1, λ = 1
      await staking.setRebateParameters(1, 1, 1, 1)

      // First collection
      // Indexer gets rebates and burn
      const firstRebates = await shouldCollect(tokensToCollect, anotherAllocationID)
      expect(firstRebates.queryRebates).gt(BigNumber.from(0))
      expect(firstRebates.queryFeesBurnt).gt(BigNumber.from(0))

      // Update rebate parameters, α = 0, λ = 1
      await staking.setRebateParameters(0, 1, 1, 1)

      // Succesive collections
      // Indexer gets 100% of the query fees
      // Parameters changed so now they are under-rebated and should get more than the available amount but we cap it
      // Distributed amount will never catch up due to the initial collection which was less than 100%
      for (const _i of [...Array(10).keys()]) {
        const succesiveRebates = await shouldCollect(tokensToCollect, anotherAllocationID)
        expect(succesiveRebates.queryRebates).eq(tokensToCollect)
        expect(succesiveRebates.queryFeesBurnt).eq(BigNumber.from(0))
      }
    })
  })

  /**
   * Close allocation
   */
  describe('closeAllocation', function () {
    beforeEach(async function () {
      // Stake and allocate
      await staking.connect(indexer.signer).stake(tokensToStake)
    })

    for (const tokensToAllocate of [toBN(100), toBN(0)]) {
      context(`> with ${tokensToAllocate} allocated tokens`, async function () {
        beforeEach(async function () {
          // Advance to next epoch to avoid creating the allocation
          // right at the epoch boundary, which would mess up the tests.
          await advanceToNextEpoch(epochManager)

          // Allocate
          await allocate(tokensToAllocate)
        })

        it('reject close a non-existing allocation', async function () {
          const invalidAllocationID = randomHexBytes(20)
          const tx = staking.connect(indexer.signer).closeAllocation(invalidAllocationID, poi)
          await expect(tx).revertedWith('!active')
        })

        it('reject close before at least one epoch has passed', async function () {
          const tx = staking.connect(indexer.signer).closeAllocation(allocationID, poi)
          await expect(tx).revertedWith('<epochs')
        })

        it('reject close if not the owner of allocation', async function () {
          // Move at least one epoch to be able to close
          await advanceToNextEpoch(epochManager)

          // Close allocation
          const tx = staking.connect(me.signer).closeAllocation(allocationID, poi)
          await expect(tx).revertedWith('!auth')
        })

        it('reject close if allocation is already closed', async function () {
          // Move at least one epoch to be able to close
          await advanceToNextEpoch(epochManager)

          // First closing
          await staking.connect(indexer.signer).closeAllocation(allocationID, poi)

          // Second closing
          const tx = staking.connect(indexer.signer).closeAllocation(allocationID, poi)
          await expect(tx).revertedWith('!active')
        })

        it('should close an allocation', async function () {
          // Before state
          const beforeStake = await staking.stakes(indexer.address)
          const beforeAlloc = await staking.getAllocation(allocationID)

          // Move at least one epoch to be able to close
          await advanceToNextEpoch(epochManager)
          await advanceToNextEpoch(epochManager)

          // Calculations
          const currentEpoch = await epochManager.currentEpoch()

          // Close allocation
          const tx = staking.connect(indexer.signer).closeAllocation(allocationID, poi)
          await expect(tx)
            .emit(staking, 'AllocationClosed')
            .withArgs(
              indexer.address,
              subgraphDeploymentID,
              currentEpoch,
              beforeAlloc.tokens,
              allocationID,
              indexer.address,
              poi,
              false,
            )

          // After state
          const afterStake = await staking.stakes(indexer.address)
          const afterAlloc = await staking.getAllocation(allocationID)

          // Stake updated
          expect(afterStake.tokensAllocated).eq(beforeStake.tokensAllocated.sub(beforeAlloc.tokens))
          // Allocation updated
          expect(afterAlloc.closedAtEpoch).eq(currentEpoch)
        })

        it('should close an allocation (by operator)', async function () {
          // Move at least one epoch to be able to close
          await advanceToNextEpoch(epochManager)
          await advanceToNextEpoch(epochManager)

          // Reject to close if the address is not operator
          const tx1 = staking.connect(me.signer).closeAllocation(allocationID, poi)
          await expect(tx1).revertedWith('!auth')

          // Should close if given operator auth
          await staking.connect(indexer.signer).setOperator(me.address, true)
          await staking.connect(me.signer).closeAllocation(allocationID, poi)
        })

        it('should close an allocation (by public) only if allocation is non-zero', async function () {
          // Reject to close if public address and under max allocation epochs
          const tx1 = staking.connect(me.signer).closeAllocation(allocationID, poi)
          await expect(tx1).revertedWith('<epochs')

          // Move max allocation epochs to close by delegator
          const maxAllocationEpochs = await staking.maxAllocationEpochs()
          await advanceEpochs(epochManager, maxAllocationEpochs + 1)

          // Closing should only be possible if allocated tokens > 0
          const alloc = await staking.getAllocation(allocationID)
          if (alloc.tokens.gt(0)) {
            // Calculations
            const beforeAlloc = await staking.getAllocation(allocationID)
            const currentEpoch = await epochManager.currentEpoch()

            // Setup
            await grt.connect(governor.signer).mint(me.address, toGRT('1'))
            await grt.connect(me.signer).approve(staking.address, toGRT('1'))

            // Should close by public
            const tx = staking.connect(me.signer).closeAllocation(allocationID, poi)
            await expect(tx)
              .emit(staking, 'AllocationClosed')
              .withArgs(
                indexer.address,
                subgraphDeploymentID,
                currentEpoch,
                beforeAlloc.tokens,
                allocationID,
                me.address,
                poi,
                true,
              )
          } else {
            // closing by the public on a zero allocation is not authorized
            const tx = staking.connect(me.signer).closeAllocation(allocationID, poi)
            await expect(tx).revertedWith('!auth')
          }
        })

        it('should close many allocations in batch', async function () {
          // Setup a second allocation
          await staking.connect(indexer.signer).stake(tokensToStake)
          const channelKey2 = deriveChannelKey()
          const allocationID2 = channelKey2.address
          await staking
            .connect(indexer.signer)
            .allocate(
              subgraphDeploymentID,
              tokensToAllocate,
              allocationID2,
              metadata,
              await channelKey2.generateProof(indexer.address),
            )

          // Move at least one epoch to be able to close
          await advanceToNextEpoch(epochManager)
          await advanceToNextEpoch(epochManager)

          // Close multiple allocations in one tx
          const requests = await Promise.all(
            [
              {
                allocationID: allocationID,
                poi: poi,
              },
              {
                allocationID: allocationID2,
                poi: poi,
              },
            ].map(({ allocationID, poi }) =>
              staking
                .connect(indexer.signer)
                .populateTransaction.closeAllocation(allocationID, poi),
            ),
          ).then((e) => e.map((e: PopulatedTransaction) => e.data))
          await staking.connect(indexer.signer).multicall(requests)
        })
      })
    }
  })

  describe('closeAndAllocate', function () {
    beforeEach(async function () {
      // Stake and allocate
      await staking.connect(indexer.signer).stake(tokensToAllocate)
      await allocate(tokensToAllocate)
    })

    it('should close and create a new allocation', async function () {
      // Move at least one epoch to be able to close
      await advanceToNextEpoch(epochManager)

      // Close and allocate
      const newChannelKey = deriveChannelKey()
      const newAllocationID = newChannelKey.address

      // Close multiple allocations in one tx
      const requests = await Promise.all([
        staking.connect(indexer.signer).populateTransaction.closeAllocation(allocationID, poi),
        staking
          .connect(indexer.signer)
          .populateTransaction.allocateFrom(
            indexer.address,
            subgraphDeploymentID,
            tokensToAllocate,
            newAllocationID,
            metadata,
            await newChannelKey.generateProof(indexer.address),
          ),
      ]).then((e) => e.map((e: PopulatedTransaction) => e.data))
      await staking.connect(indexer.signer).multicall(requests)
    })
  })
})
