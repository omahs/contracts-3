import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { BigNumberish, ethers } from 'ethers'
import { NetworkContracts } from '../../../cli/contracts'
import { randomHexBytes, sendTransaction } from '../../../cli/network'
import { ensureGRTAllowance } from './helpers'

export const stake = async (
  contracts: NetworkContracts,
  indexer: SignerWithAddress,
  amount: BigNumberish,
): Promise<void> => {
  // Approve
  await ensureGRTAllowance(contracts, indexer, indexer.address, contracts.Staking.address, amount)

  // Stake
  console.log(`\nStaking ${amount} tokens...`)
  await sendTransaction(indexer, contracts.Staking, 'stake', [amount])
}

export const allocateFrom = async (
  contracts: NetworkContracts,
  indexer: SignerWithAddress,
  allocationSigner: SignerWithAddress,
  subgraphDeploymentID: string,
  amount: BigNumberish,
): Promise<void> => {
  const allocationId = allocationSigner.address
  const messageHash = ethers.utils.solidityKeccak256(
    ['address', 'address'],
    [indexer.address, allocationId],
  )
  const messageHashBytes = ethers.utils.arrayify(messageHash)
  const proof = await allocationSigner.signMessage(messageHashBytes)
  const metadata = ethers.constants.HashZero

  console.log(`\nAllocating ${amount} tokens on ${allocationId}...`)
  await sendTransaction(
    indexer,
    contracts.Staking,
    'allocateFrom',
    [indexer.address, subgraphDeploymentID, amount, allocationId, metadata, proof],
    {
      gasLimit: 2000000,
    },
  )
}

export const closeAllocation = async (
  contracts: NetworkContracts,
  indexer: SignerWithAddress,
  allocationId: string,
): Promise<void> => {
  const poi = randomHexBytes()

  console.log(`\nClosing ${allocationId}...`)
  await sendTransaction(indexer, contracts.Staking, 'closeAllocation', [allocationId, poi])
}
