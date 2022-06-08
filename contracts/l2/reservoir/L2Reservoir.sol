// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../../reservoir/IReservoir.sol";
import "../../reservoir/Reservoir.sol";
import "./IL2Reservoir.sol";
import "./L2ReservoirStorage.sol";

/**
 * @title L2 Rewards Reservoir
 * @dev This contract acts as a reservoir/vault for the rewards to be distributed on Layer 2.
 * It receives tokens for rewards from L1, and provides functions to compute accumulated and new
 * total rewards at a particular block number.
 */
contract L2Reservoir is L2ReservoirV2Storage, Reservoir, IL2Reservoir {
    using SafeMath for uint256;

    event DripReceived(uint256 _issuanceBase);
    event NextDripNonceUpdated(uint256 _nonce);

    /**
     * @dev Checks that the sender is the L2GraphTokenGateway as configured on the Controller.
     */
    modifier onlyL2Gateway() {
        require(msg.sender == address(graphTokenGateway()), "ONLY_GATEWAY");
        _;
    }

    /**
     * @dev Initialize this contract.
     * The contract will be paused. Note that issuance parameters
     * are not set here because they are set from L1 through the drip function.
     * The RewardsManager's address might also not be available in the controller at initialization
     * time, so approveRewardsManager() must be called separately.
     * @param _controller Address of the Controller that manages this contract
     */
    function initialize(address _controller) external onlyImpl {
        Managed._initialize(_controller);
    }

    /**
     * @dev Update the next drip nonce
     * To be used only as a backup option if the two layers get out of sync.
     * @param _nonce Expected value for the nonce of the next drip message
     */
    function setNextDripNonce(uint256 _nonce) external onlyGovernor {
        nextDripNonce = _nonce;
        emit NextDripNonceUpdated(_nonce);
    }

    /**
     * @dev Get new total rewards accumulated since the last drip.
     * This is deltaR = p * r ^ (blocknum - t0) - p, where:
     * - p is the issuance base at t0 (normalized by the L2 rewards fraction)
     * - t0 is the last drip block, i.e. lastRewardsUpdateBlock
     * - r is the issuanceRate
     * @param _blocknum Block number at which to calculate rewards
     * @return New total rewards on L2 since the last drip
     */
    function getNewRewards(uint256 _blocknum)
        public
        view
        override(Reservoir, IReservoir)
        returns (uint256)
    {
        uint256 t0 = lastRewardsUpdateBlock;
        if (issuanceRate <= MIN_ISSUANCE_RATE || _blocknum == t0) {
            return 0;
        }
        return
            issuanceBase
                .mul(_pow(issuanceRate, _blocknum.sub(t0), FIXED_POINT_SCALING_FACTOR))
                .div(FIXED_POINT_SCALING_FACTOR)
                .sub(issuanceBase);
    }

    /**
     * @dev Receive dripped tokens from L1.
     * This function can only be called by the gateway, as it is
     * meant to be a callhook when receiving tokens from L1. It
     * updates the issuanceBase and issuanceRate,
     * and snapshots the accumulated rewards. If issuanceRate changes,
     * it also triggers a snapshot of rewards per signal on the RewardsManager.
     * Note that the transaction might revert if it's received out-of-order,
     * because it checks an incrementing nonce. If that is the case, the retryable ticket can be redeemed
     * again once the ticket for previous drip has been redeemed.
     * A keeper reward will be sent to the keeper that dripped on L1, and part of it
     * to whoever redeemed the current retryable ticket (tx.origin)
     * @param _issuanceBase Base value for token issuance (approximation for token supply times L2 rewards fraction)
     * @param _issuanceRate Rewards issuance rate, using fixed point at 1e18, and including a +1
     * @param _nonce Incrementing nonce to ensure messages are received in order
     * @param _keeperReward Keeper reward to distribute between keeper that called drip and keeper that redeemed  the retryable tx
     * @param _l1Keeper Address of the keeper that called drip in L1
     */
    function receiveDrip(
        uint256 _issuanceBase,
        uint256 _issuanceRate,
        uint256 _nonce,
        uint256 _keeperReward,
        address _l1Keeper
    ) external override onlyL2Gateway {
        require(_nonce == nextDripNonce, "INVALID_NONCE");
        nextDripNonce = nextDripNonce.add(1);
        if (_issuanceRate != issuanceRate) {
            rewardsManager().updateAccRewardsPerSignal();
            snapshotAccumulatedRewards();
            issuanceRate = _issuanceRate;
            emit IssuanceRateUpdated(_issuanceRate);
        } else {
            snapshotAccumulatedRewards();
        }
        issuanceBase = _issuanceBase;
        IGraphToken grt = graphToken();
        // We'd like to reward the keeper that redeemed the tx in L2
        // but this won't work right now as tx.origin will actually be the L1 sender.
        // uint256 _l2KeeperReward = _keeperReward.mul(l2KeeperRewardFraction).div(TOKEN_DECIMALS);
        // // solhint-disable-next-line avoid-tx-origin
        // grt.transfer(tx.origin, _l2KeeperReward);
        // grt.transfer(_l1Keeper, _keeperReward.sub(_l2KeeperReward));
        // So for now we just send all the rewards to teh L1 keeper:
        grt.transfer(_l1Keeper, _keeperReward);
        emit DripReceived(issuanceBase);
    }

    /**
     * @dev Snapshot accumulated rewards on this layer
     * We compute accumulatedLayerRewards and mark this block as the lastRewardsUpdateBlock.
     */
    function snapshotAccumulatedRewards() internal {
        accumulatedLayerRewards = getAccumulatedRewards(block.number);
        lastRewardsUpdateBlock = block.number;
    }
}
