const { expect } = require("chai");

const { getAssetInfo, ilks } = require('@defisaver/tokens');

const dfs = require('@defisaver/sdk')

const {
    getAddrFromRegistry,
    getProxy,
    redeploy,
    send,
    formatExchangeObj,
    setNewExchangeWrapper,
    balanceOf,
    isEth,
    nullAddress,
    standardAmounts,
    WETH_ADDRESS,
    MIN_VAULT_DAI_AMOUNT,
    MAX_UINT
} = require('../../utils');

const {
    fetchMakerAddresses,
    getVaultsForUser,
    getRatio,
    getVaultInfo,
    MCD_MANAGER_ADDR,
    canGenerateDebt,
} = require('../../utils-mcd');

const {
    sell,
    openVault,
} = require('../../actions.js');

const BigNumber = hre.ethers.BigNumber;

describe("Mcd-Close", function() {
    this.timeout(80000);

    let makerAddresses, senderAcc, proxy, dydxFlAddr, mcdView, uniWrapper, taskExecutorAddr;

    before(async () => {
        await redeploy('TaskExecutor');
        await redeploy('FLDyDx');
        await redeploy('DFSBuy');
        await redeploy('DFSSell');
        await redeploy('SendToken');

        mcdView = await redeploy('McdView');

        makerAddresses = await fetchMakerAddresses();
        uniWrapper = await redeploy('UniswapWrapperV3');

        taskExecutorAddr = await getAddrFromRegistry('TaskExecutor');
        dydxFlAddr = await getAddrFromRegistry('FLDyDx');

        senderAcc = (await hre.ethers.getSigners())[0];
        proxy = await getProxy(senderAcc.address);

        await setNewExchangeWrapper(senderAcc, uniWrapper.address);
    });

    for (let i = 0; i < 1; ++i) {
        const ilkData = ilks[i];
        const tokenData = getAssetInfo(ilkData.asset);

        if (tokenData.symbol === 'ETH') {
            tokenData.address = WETH_ADDRESS;
        }

        const joinAddr = ilkData.join;
        const tokenAddr = tokenData.address;

        it(`... should close a ${ilkData.ilkLabel} Vault and return Dai`, async () => {
            const canGenerate = await canGenerateDebt(ilkData);
            if (!canGenerate) {
                expect(true).to.be.true;
                return;
            }

            const vaultColl = (standardAmounts[tokenData.symbol] * 2).toString();

            const amountDai = (parseInt(MIN_VAULT_DAI_AMOUNT) + 200).toString();

            const vaultId = await openVault(
                makerAddresses,
                proxy,
                joinAddr,
                tokenData,
                vaultColl,
                amountDai
            );

            const daiAddr = makerAddresses["MCD_DAI"];

            // Vault debt + 1 dai to handle stability fee
            let flAmount = (parseFloat(amountDai) + 1).toString();
            flAmount = ethers.utils.parseUnits(flAmount, 18);

            console.log(ethers.utils.parseUnits(vaultColl, tokenData.decimals).toString());

            const exchangeOrder = formatExchangeObj(
                tokenAddr,
                daiAddr,
                ethers.utils.parseUnits(vaultColl, tokenData.decimals),
                uniWrapper.address
            );

            const closeToDaiVaultRecipe = new dfs.Recipe("CloseToDaiVaultRecipe", [
                new dfs.actions.flashloan.DyDxFlashLoanAction(flAmount, daiAddr, nullAddress, []),
                new dfs.actions.maker.MakerPaybackAction(vaultId, MAX_UINT, proxy.address, MCD_MANAGER_ADDR),
                new dfs.actions.maker.MakerWithdrawAction(vaultId, MAX_UINT, joinAddr, proxy.address, MCD_MANAGER_ADDR),
                new dfs.actions.basic.SellAction(exchangeOrder, proxy.address, proxy.address),
                new dfs.actions.basic.SendTokenAction(daiAddr, dydxFlAddr, flAmount),
                new dfs.actions.basic.SendTokenAction(daiAddr, senderAcc.address, MAX_UINT) // return extra dai
            ]);

            const functionData = closeToDaiVaultRecipe.encodeForDsProxyCall();

            const daiBalanceBefore = await balanceOf(daiAddr, senderAcc.address);
            console.log(`Dai balance before: ${daiBalanceBefore / 1e18}`);

            await proxy['execute(address,bytes)'](taskExecutorAddr, functionData[1], { gasLimit: 3000000});

            const daiBalanceAfter = await balanceOf(daiAddr, senderAcc.address);
            console.log(`Dai balance before: ${daiBalanceAfter / 1e18}`);

            expect(daiBalanceAfter).to.be.gt(daiBalanceBefore);
        });

        it(`... should close a ${ilkData.ilkLabel} Vault and return collateral`, async () => {
            const canGenerate = await canGenerateDebt(ilkData);
            if (!canGenerate) {
                expect(true).to.be.true;
                return;
            }

            const amountDai = (parseInt(MIN_VAULT_DAI_AMOUNT) + 200).toString();
            const amountColl = (standardAmounts[tokenData.symbol] * 2).toString();

            const vaultId = await openVault(
                makerAddresses,
                proxy,
                joinAddr,
                tokenData,
                amountColl,
                amountDai
            );

            // Vault debt + 1 dai to handle stability fee
            let flAmount = (parseFloat(amountDai) + 1).toString();
            flAmount = ethers.utils.parseUnits(flAmount, 18);

            const daiAddr = makerAddresses["MCD_DAI"];

            const exchangeOrder = formatExchangeObj(
                tokenAddr,
                daiAddr,
                ethers.utils.parseUnits(amountColl, tokenData.decimals),
                uniWrapper.address,
                flAmount
            );

            const closeToCollVaultRecipe = new dfs.Recipe("CloseToCollVaultRecipe", [
                new dfs.actions.flashloan.DyDxFlashLoanAction(flAmount, daiAddr, nullAddress, []),
                new dfs.actions.maker.MakerPaybackAction(vaultId, MAX_UINT, proxy.address, MCD_MANAGER_ADDR),
                new dfs.actions.maker.MakerWithdrawAction(vaultId, MAX_UINT, joinAddr, proxy.address, MCD_MANAGER_ADDR),
                new dfs.actions.basic.BuyAction(exchangeOrder, proxy.address, dydxFlAddr),
                new dfs.actions.basic.SendTokenAction(tokenAddr, senderAcc.address, MAX_UINT)
            ]);

            const functionData = closeToCollVaultRecipe.encodeForDsProxyCall();

            const collBalanceBefore = await balanceOf(tokenAddr, senderAcc.address);
            console.log(`Coll balance before: ${collBalanceBefore / 10**tokenData.decimals}`);

            await proxy['execute(address,bytes)'](taskExecutorAddr, functionData[1], { gasLimit: 3000000});

            const collBalanceAfter = await balanceOf(tokenAddr, senderAcc.address);
            console.log(`Coll balance after: ${collBalanceAfter / 10**tokenData.decimals}`);

            expect(collBalanceAfter).to.be.gt(collBalanceBefore);
        });

    }

});
