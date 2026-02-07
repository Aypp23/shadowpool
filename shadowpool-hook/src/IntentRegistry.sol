// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

contract IntentRegistry is Ownable {
    error InvalidProtectedData();
    error InvalidCommitment();
    error IntentAlreadyRegistered();
    error InvalidTrader();
    error ArrayLengthMismatch();
    error InvalidRoundId();
    error IntakeWindowClosed();
    error InvalidRoundConfig();

    event IntentRegistered(
        bytes32 indexed roundId,
        address indexed trader,
        address indexed protectedData,
        bytes32 commitment,
        uint256 position,
        bytes32 intentId,
        uint256 timestamp
    );

    struct IntentRef {
        address trader;
        address protectedData;
        bytes32 commitment;
        bytes32 intentId;
        uint64 timestamp;
    }

    mapping(bytes32 roundId => IntentRef[] intents) private _intents;
    mapping(bytes32 roundId => mapping(address protectedData => bool registered)) private _registered;

    bytes32 private _namespace;
    uint256 private _durationSeconds;
    uint256 private _intakeWindowSeconds;

    constructor(address owner, bytes32 namespace, uint256 durationSeconds, uint256 intakeWindowSeconds) Ownable(owner) {
        if (durationSeconds == 0 || intakeWindowSeconds == 0 || intakeWindowSeconds > durationSeconds) revert InvalidRoundConfig();
        _namespace = namespace;
        _durationSeconds = durationSeconds;
        _intakeWindowSeconds = intakeWindowSeconds;
    }

    function namespace() external view returns (bytes32) {
        return _namespace;
    }

    function durationSeconds() external view returns (uint256) {
        return _durationSeconds;
    }

    function intakeWindowSeconds() external view returns (uint256) {
        return _intakeWindowSeconds;
    }

    function computeRoundStartSeconds(uint256 timestamp) public view returns (uint256) {
        return (timestamp / _durationSeconds) * _durationSeconds;
    }

    function computeRoundId(uint256 timestamp) public view returns (bytes32) {
        return keccak256(abi.encodePacked(_namespace, computeRoundStartSeconds(timestamp)));
    }

    function computeCommitment(
        uint8 sideAsUint8,
        address trader,
        address baseToken,
        address quoteToken,
        uint256 amountBaseWei,
        uint256 limitPriceWad,
        uint64 expirySeconds,
        bytes32 saltBytes32
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encode(sideAsUint8, trader, baseToken, quoteToken, amountBaseWei, limitPriceWad, expirySeconds, saltBytes32)
        );
    }

    function currentRoundStartSeconds() external view returns (uint256) {
        return computeRoundStartSeconds(block.timestamp);
    }

    function currentRoundId() external view returns (bytes32) {
        return computeRoundId(block.timestamp);
    }

    function isWithinIntakeWindow(uint256 timestamp) public view returns (bool) {
        uint256 roundStart = computeRoundStartSeconds(timestamp);
        return timestamp - roundStart < _intakeWindowSeconds;
    }

    function _validateRoundSchedule(bytes32 roundId) internal view {
        if (roundId != computeRoundId(block.timestamp)) revert InvalidRoundId();
        if (!isWithinIntakeWindow(block.timestamp)) revert IntakeWindowClosed();
    }

    function getIntentCount(bytes32 roundId) external view returns (uint256) {
        return _intents[roundId].length;
    }

    function getIntentAt(bytes32 roundId, uint256 index) external view returns (IntentRef memory) {
        return _intents[roundId][index];
    }

    function isIntentRegistered(bytes32 roundId, address protectedData) external view returns (bool) {
        return _registered[roundId][protectedData];
    }

    function registerIntent(bytes32 roundId, address protectedData, bytes32 commitment)
        external
        returns (uint256 position)
    {
        _validateRoundSchedule(roundId);
        position = _registerIntent(roundId, msg.sender, protectedData, commitment);
    }

    function registerIntents(bytes32 roundId, address[] calldata protectedData, bytes32[] calldata commitment)
        external
        returns (uint256 fromPosition, uint256 toPosition)
    {
        _validateRoundSchedule(roundId);
        if (protectedData.length != commitment.length) revert ArrayLengthMismatch();
        if (protectedData.length == 0) return (0, 0);

        uint256 startCount = _intents[roundId].length;
        for (uint256 i = 0; i < protectedData.length; i++) {
            _registerIntent(roundId, msg.sender, protectedData[i], commitment[i]);
        }
        fromPosition = startCount + 1;
        toPosition = _intents[roundId].length;
    }

    function registerIntentFor(bytes32 roundId, address trader, address protectedData, bytes32 commitment)
        external
        onlyOwner
        returns (uint256 position)
    {
        _validateRoundSchedule(roundId);
        if (trader == address(0)) revert InvalidTrader();
        position = _registerIntent(roundId, trader, protectedData, commitment);
    }

    function registerIntentsFor(
        bytes32 roundId,
        address[] calldata trader,
        address[] calldata protectedData,
        bytes32[] calldata commitment
    ) external onlyOwner returns (uint256 fromPosition, uint256 toPosition) {
        _validateRoundSchedule(roundId);
        if (trader.length != protectedData.length || trader.length != commitment.length) {
            revert ArrayLengthMismatch();
        }
        if (trader.length == 0) return (0, 0);

        uint256 startCount = _intents[roundId].length;
        for (uint256 i = 0; i < trader.length; i++) {
            if (trader[i] == address(0)) revert InvalidTrader();
            _registerIntent(roundId, trader[i], protectedData[i], commitment[i]);
        }
        fromPosition = startCount + 1;
        toPosition = _intents[roundId].length;
    }

    function _registerIntent(bytes32 roundId, address trader, address protectedData, bytes32 commitment)
        internal
        returns (uint256 position)
    {
        if (trader == address(0)) revert InvalidTrader();
        if (protectedData == address(0)) revert InvalidProtectedData();
        if (commitment == bytes32(0)) revert InvalidCommitment();
        if (_registered[roundId][protectedData]) revert IntentAlreadyRegistered();

        _registered[roundId][protectedData] = true;
        bytes32 intentId = keccak256(abi.encodePacked(roundId, trader, protectedData, commitment));
        uint64 ts = uint64(block.timestamp);
        _intents[roundId].push(
            IntentRef({
                trader: trader,
                protectedData: protectedData,
                commitment: commitment,
                intentId: intentId,
                timestamp: ts
            })
        );
        position = _intents[roundId].length;
        emit IntentRegistered(roundId, trader, protectedData, commitment, position, intentId, ts);
    }
}
