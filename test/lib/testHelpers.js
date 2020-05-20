const BN = web3.utils.BN

module.exports = {
  randomSubgraphId: () => web3.utils.randomHex(32),
  logStake: stakes =>
    Object.entries(stakes).map(([k, v]) => console.log(k, ':', web3.utils.fromWei(v))),
  zerobytes: () =>
    web3.utils.hexToBytes('0x0000000000000000000000000000000000000000000000000000000000000000'),
  zeroHex: () => '0x0000000000000000000000000000000000000000000000000000000000000000',
  zeroAddress: () => '0x0000000000000000000000000000000000000000',

  topLevelDomainNames: [...Array(100).keys()].map(e => 'tld' + e),
  subdomainNames: [...Array(100).keys()].map(e => 'subDomain' + e),
  testIPFSHashes: [
    '0xeb50d096ba95573ae31640e38e4ef64fd02eec174f586624a37ea04e7bd8c751',
    '0x3ab4598d9c0b61477f7b91502944a8e216d9e64de2116a840ca5f75692230864',
    '0x50b537c6aa4956b2acb13322fe8d3508daf0714a94888bd1a3fc26c92d62e422',
    '0x1566216996cf5f8b9ff98d86b846bb370917bdd0a3498d4adc5ba353668f815c',
    '0xa92d580bf73844f0911edc51858414d4170ff8df99fc0da9ce8a7e525cde6157',
    '0x8e05bf18a8289544b93222f183d2e44698438283daf5f72bee7e246f0f07d936',
    '0x2b8a60dd231a6e7477ad32f801b38c583ea25650a24a04d5905cea452c2e7d94',
    '0x18b2f2152d0ab77b56f1d881d489183e6fd700a5d18f42f31a7f7078fda5b011',
    '0x067fe1fb5d0c3896ddc762f41d26acac6f00e9d9fd2fb67ca434228751148a14',
    '0x217b212d19df6d06147c96409704a2896b5b4d2a8c620b27dce3140235c909cb',
  ],
  testSubgraphIDs: [
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000000000000000000000000000003',
    '0x0000000000000000000000000000000000000000000000000000000000000004',
    '0x0000000000000000000000000000000000000000000000000000000000000005',
    '0x0000000000000000000000000000000000000000000000000000000000000006',
    '0x0000000000000000000000000000000000000000000000000000000000000007',
    '0x0000000000000000000000000000000000000000000000000000000000000008',
    '0x0000000000000000000000000000000000000000000000000000000000000009',
    '0x0000000000000000000000000000000000000000000000000000000000000010',
  ],
  testServiceRegistryURLS: [
    '0x1000000000000000000000000000000000000000000000000000000000000000',
    '0x2000000000000000000000000000000000000000000000000000000000000000',
    '0x3000000000000000000000000000000000000000000000000000000000000000',
    '0x4000000000000000000000000000000000000000000000000000000000000000',
    '0x5000000000000000000000000000000000000000000000000000000000000000',
    '0x6000000000000000000000000000000000000000000000000000000000000000',
    '0x7000000000000000000000000000000000000000000000000000000000000000',
    '0x8000000000000000000000000000000000000000000000000000000000000000',
    '0x9000000000000000000000000000000000000000000000000000000000000000',
    '0x1100000000000000000000000000000000000000000000000000000000000000',
  ],

  // For some reason, when getting the tx hash from here, it works in governance.test.js line 50
  // The test for "...should be able to transfer governance of self to MultiSigWallet #2"
  getParamFromTxEvent: (transaction, paramName, contractFactory, eventName) => {
    let logs = transaction.logs || transaction.events || []
    if (eventName != null) {
      logs = logs.filter(l => l.event === eventName)
    }
    assert.equal(logs.length, 1, 'too many logs found!')
    const param = logs[0].args[paramName]
    if (contractFactory != null) {
      const contract = contractFactory.at(param)
      assert.isObject(contract, `getting ${paramName} failed for ${param}`)
      return contract
    } else return param
  },
  defaults: {
    curation: {
      // Reserve ratio to set bonding curve for curation (in PPM)
      reserveRatio: new BN('500000'),
      // Minimum amount required to be staked by Curators
      minimumCurationStake: web3.utils.toWei(new BN('100')),
      // When one user stakes 1000, they will get 3 shares returned, as per the Bancor formula
      shareAmountFor1000Tokens: new BN(3),
    },
    dispute: {
      minimumDeposit: web3.utils.toWei(new BN('100')),
      fishermanRewardPercentage: new BN(1000), // in basis points
      slashingPercentage: new BN(1000), // in basis points
    },
    epochs: {
      lengthInBlocks: new BN((24 * 60 * 60) / 15), // One day in blocks
    },
    staking: {
      channelDisputeEpochs: 1,
      maxAllocationEpochs: 5,
      thawingPeriod: 20, // in blocks
    },
    token: {
      initialSupply: web3.utils.toWei(new BN('10000000')),
    },
  },
}
