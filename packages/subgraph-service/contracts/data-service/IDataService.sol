// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { IGraphPayments } from "../interfaces/IGraphPayments.sol";

interface IDataService {
    function register(address serviceProvider, bytes calldata data) external;
    function acceptProvision(address serviceProvider, bytes calldata data) external;
    function startService(address serviceProvider, bytes calldata data) external;
    function collectServicePayment(address serviceProvider, bytes calldata data) external;
    function stopService(address serviceProvider, bytes calldata data) external;
    function redeem(
        address serviceProvider,
        IGraphPayments.PaymentTypes feeType,
        bytes calldata data
    ) external returns (uint256 fees);
    function slash(address serviceProvider, bytes calldata data) external;
}
