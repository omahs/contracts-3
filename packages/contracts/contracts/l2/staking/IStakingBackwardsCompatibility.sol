// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity >=0.6.12 <0.8.0;
pragma abicoder v2;

/**
 * @title Base interface for the Staking contract.
 * @dev This interface includes only what's implemented in the base Staking contract.
 * It does not include the L1 and L2 specific functionality. It also does not include
 * several functions that are implemented in the StakingExtension contract, and are called
 * via delegatecall through the fallback function. See IStaking.sol for an interface
 * that includes the full functionality.
 */
interface IStakingBackwardsCompatibility {
    /**
     * @dev Emitted when `delegator` delegated `tokens` to the `serviceProvider`, the delegator
     * gets `shares` for the delegation pool proportionally to the tokens staked.
     * This event is here for backwards compatibility, the tokens are delegated
     * on the subgraph data service provision.
     */
    event StakeDelegated(
        address indexed serviceProvider,
        address indexed delegator,
        uint256 tokens,
        uint256 shares
    );

    /**
     * @dev Allocate GRT tokens for the purpose of serving queries of a subgraph deployment
     * An allocation is created in the allocate() function and closed in closeAllocation()
     */
    struct Allocation {
        address indexer;
        bytes32 subgraphDeploymentID;
        uint256 tokens; // Tokens allocated to a SubgraphDeployment
        uint256 createdAtEpoch; // Epoch when it was created
        uint256 closedAtEpoch; // Epoch when it was closed
        uint256 collectedFees; // Collected fees for the allocation
        uint256 __DEPRECATED_effectiveAllocation; // solhint-disable-line var-name-mixedcase
        uint256 accRewardsPerAllocatedToken; // Snapshot used for reward calc
        uint256 distributedRebates; // Collected rebates that have been rebated
    }
    /**
     * @dev Emitted when `serviceProvider` stakes `tokens` amount.
     */
    event StakeDeposited(address indexed serviceProvider, uint256 tokens);

    /**
     * @dev Emitted when `serviceProvider` withdraws `tokens` amount.
     */
    event StakeWithdrawn(address indexed serviceProvider, uint256 tokens);

    /**
     * @dev Emitted when `serviceProvider` locks `tokens` amount until `until`.
     */
    event StakeLocked(address indexed serviceProvider, uint256 tokens, uint256 until);

    /**
     * @dev Emitted when `indexer` close an allocation in `epoch` for `allocationID`.
     * An amount of `tokens` get unallocated from `subgraphDeploymentID`.
     * This event also emits the POI (proof of indexing) submitted by the indexer.
     * `isPublic` is true if the sender was someone other than the indexer.
     */
    event AllocationClosed(
        address indexed indexer,
        bytes32 indexed subgraphDeploymentID,
        uint256 epoch,
        uint256 tokens,
        address indexed allocationID,
        address sender,
        bytes32 poi,
        bool isPublic
    );

    /**
     * @dev Emitted when `indexer` collects a rebate on `subgraphDeploymentID` for `allocationID`.
     * `epoch` is the protocol epoch the rebate was collected on
     * The rebate is for `tokens` amount which are being provided by `assetHolder`; `queryFees`
     * is the amount up for rebate after `curationFees` are distributed and `protocolTax` is burnt.
     * `queryRebates` is the amount distributed to the `indexer` with `delegationFees` collected
     * and sent to the delegation pool.
     */
    event RebateCollected(
        address assetHolder,
        address indexed indexer,
        bytes32 indexed subgraphDeploymentID,
        address indexed allocationID,
        uint256 epoch,
        uint256 tokens,
        uint256 protocolTax,
        uint256 curationFees,
        uint256 queryFees,
        uint256 queryRebates,
        uint256 delegationRewards
    );

    /**
     * @dev Emitted when `indexer` set `operator` access in the legacy contract,
     * which now means only for the subgraph data service.
     */
    event SetOperator(address indexed indexer, address indexed operator, bool allowed);

    /**
     * @dev Possible states an allocation can be.
     * States:
     * - Null = indexer == address(0)
     * - Active = not Null && tokens > 0
     * - Closed = Active && closedAtEpoch != 0
     */
    enum AllocationState {
        Null,
        Active,
        Closed
    }

    /**
     * @notice Set the address of the counterpart (L1 or L2) staking contract.
     * @dev This function can only be called by the governor.
     * @param _counterpart Address of the counterpart staking contract in the other chain, without any aliasing.
     */
    function setCounterpartStakingAddress(address _counterpart) external;

    /**
     * @notice Close an allocation and free the staked tokens.
     * To be eligible for rewards a proof of indexing must be presented.
     * Presenting a bad proof is subject to slashable condition.
     * To opt out of rewards set _poi to 0x0
     * @param _allocationID The allocation identifier
     * @param _poi Proof of indexing submitted for the allocated period
     */
    function closeAllocation(address _allocationID, bytes32 _poi) external;

    /**
     * @notice Collect query fees from state channels and assign them to an allocation.
     * Funds received are only accepted from a valid sender.
     * @dev To avoid reverting on the withdrawal from channel flow this function will:
     * 1) Accept calls with zero tokens.
     * 2) Accept calls after an allocation passed the dispute period, in that case, all
     *    the received tokens are burned.
     * @param _tokens Amount of tokens to collect
     * @param _allocationID Allocation where the tokens will be assigned
     */
    function collect(uint256 _tokens, address _allocationID) external;

    /**
     * @notice Return true if operator is allowed for indexer.
     * @param _operator Address of the operator
     * @param _indexer Address of the indexer
     * @return True if operator is allowed for indexer, false otherwise
     */
    function isOperator(address _operator, address _indexer) external view returns (bool);

    /**
     * @notice Getter that returns if an indexer has any stake.
     * @param _indexer Address of the indexer
     * @return True if indexer has staked tokens
     */
    function hasStake(address _indexer) external view returns (bool);

    /**
     * @notice Get the total amount of tokens staked by the indexer.
     * @param _indexer Address of the indexer
     * @return Amount of tokens staked by the indexer
     */
    function getIndexerStakedTokens(address _indexer) external view returns (uint256);

    /**
     * @notice Return the allocation by ID.
     * @param _allocationID Address used as allocation identifier
     * @return Allocation data
     */
    function getAllocation(address _allocationID) external view returns (Allocation memory);

    /**
     * @notice Return the current state of an allocation
     * @param _allocationID Allocation identifier
     * @return AllocationState enum with the state of the allocation
     */
    function getAllocationState(address _allocationID) external view returns (AllocationState);

    /**
     * @notice Return if allocationID is used.
     * @param _allocationID Address used as signer by the indexer for an allocation
     * @return True if allocationID already used
     */
    function isAllocation(address _allocationID) external view returns (bool);

    /**
     * @notice Return the total amount of tokens allocated to subgraph.
     * @param _subgraphDeploymentID Deployment ID for the subgraph
     * @return Total tokens allocated to subgraph
     */
    function getSubgraphAllocatedTokens(bytes32 _subgraphDeploymentID)
        external
        view
        returns (uint256);

    /**
     * @notice Check if an operator is authorized for the caller on a specific verifier / data service.
     * @dev They might be the service provider, a global operator or a verifier-specific operator.
     * @param _operator The address to check for auth
     * @param _serviceProvider The service provider on behalf of whom they're claiming to act
     * @param _verifier The verifier / data service on which they're claiming to act
     */
    function isAuthorized(
        address _operator,
        address _serviceProvider,
        address _verifier
    ) external view returns (bool);
}
