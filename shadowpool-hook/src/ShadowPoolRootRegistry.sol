// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

contract ShadowPoolRootRegistry is Ownable {
    error RoundClosed();
    error RoundNotClosed();
    error RootAlreadySet();
    error InvalidProtectedData();
    error IntentAlreadySubmitted();
    error InvalidRoot();
    error InvalidValidUntil();
    error RootLocked();
    error NotMatcher();
    error RootNotSet();

    event RootPosted(bytes32 indexed roundId, bytes32 indexed root, uint256 validUntil);
    event IntentSubmitted(bytes32 indexed roundId, address indexed protectedData, uint256 position);
    event RoundClosedByOwner(bytes32 indexed roundId);
    event MatcherSet(bytes32 indexed roundId, address indexed matcher);
    event RootLockedForRound(bytes32 indexed roundId);

    mapping(bytes32 roundId => bytes32 root) private _roots;
    mapping(bytes32 roundId => uint256 validUntil) private _rootValidUntil;
    mapping(bytes32 roundId => address matcher) private _matcher;
    mapping(bytes32 roundId => bool locked) private _rootLocked;
    mapping(bytes32 roundId => bool closed) private _roundClosed;
    mapping(bytes32 roundId => address[] intents) private _roundIntents;
    mapping(bytes32 roundId => mapping(address protectedData => bool submitted)) private _intentSubmitted;

    constructor(address owner) Ownable(owner) {}

    function getRoot(bytes32 roundId) external view returns (bytes32) {
        return _roots[roundId];
    }

    function getRootValidUntil(bytes32 roundId) external view returns (uint256) {
        return _rootValidUntil[roundId];
    }

    function getMatcher(bytes32 roundId) external view returns (address) {
        return _matcher[roundId];
    }

    function isRootLocked(bytes32 roundId) external view returns (bool) {
        return _rootLocked[roundId];
    }

    function isRoundClosed(bytes32 roundId) external view returns (bool) {
        return _roundClosed[roundId];
    }

    function isRootActive(bytes32 roundId) external view returns (bool) {
        bytes32 root = _roots[roundId];
        if (root == bytes32(0)) return false;
        return block.timestamp <= _rootValidUntil[roundId];
    }

    function getRoundInfo(bytes32 roundId)
        external
        view
        returns (bytes32 root, uint256 validUntil, address matcher, bool rootLocked, bool roundClosed, bool rootActive)
    {
        root = _roots[roundId];
        validUntil = _rootValidUntil[roundId];
        matcher = _matcher[roundId];
        rootLocked = _rootLocked[roundId];
        roundClosed = _roundClosed[roundId];
        rootActive = root != bytes32(0) && block.timestamp <= validUntil;
    }

    function getIntentCount(bytes32 roundId) external view returns (uint256) {
        return _roundIntents[roundId].length;
    }

    function getIntentAt(bytes32 roundId, uint256 index) external view returns (address) {
        return _roundIntents[roundId][index];
    }

    function submitIntent(bytes32 roundId, address protectedData) external returns (uint256 position) {
        if (_roundClosed[roundId]) revert RoundClosed();
        if (_roots[roundId] != bytes32(0)) revert RootAlreadySet();
        if (protectedData == address(0)) revert InvalidProtectedData();
        if (_intentSubmitted[roundId][protectedData]) revert IntentAlreadySubmitted();

        _intentSubmitted[roundId][protectedData] = true;
        _roundIntents[roundId].push(protectedData);

        position = _roundIntents[roundId].length;
        emit IntentSubmitted(roundId, protectedData, position);
    }

    function closeRound(bytes32 roundId) external onlyOwner {
        _roundClosed[roundId] = true;
        emit RoundClosedByOwner(roundId);
    }

    function postRoot(bytes32 roundId, bytes32 root, uint256 validUntil) external {
        if (!_roundClosed[roundId]) revert RoundNotClosed();
        if (root == bytes32(0)) revert InvalidRoot();
        if (validUntil <= block.timestamp) revert InvalidValidUntil();
        if (_rootLocked[roundId]) revert RootLocked();

        address matcher = _matcher[roundId];
        if (matcher == address(0)) {
            _matcher[roundId] = msg.sender;
            emit MatcherSet(roundId, msg.sender);
        } else if (msg.sender != matcher) {
            revert NotMatcher();
        }

        _roots[roundId] = root;
        _rootValidUntil[roundId] = validUntil;
        emit RootPosted(roundId, root, validUntil);
    }

    function lockRoot(bytes32 roundId) external {
        if (!_roundClosed[roundId]) revert RoundNotClosed();
        if (_roots[roundId] == bytes32(0)) revert RootNotSet();
        if (msg.sender != _matcher[roundId]) revert NotMatcher();
        if (_rootLocked[roundId]) revert RootLocked();
        _rootLocked[roundId] = true;
        emit RootLockedForRound(roundId);
    }
}
