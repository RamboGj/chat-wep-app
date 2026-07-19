import { useEffect, useRef, useState } from 'react'
import { SignupForm } from '../components/SignupForm'
import { LoginForm } from '../components/LoginForm'
import { Tab } from '@/components/atoms/Tab/Tab'
import { Logo } from '@/components/atoms/Logo/Logo'

const AuthTab = {
  LOGIN: 'login',
  SIGNUP: 'signup',
} as const

type AuthTab = (typeof AuthTab)[keyof typeof AuthTab]

const TABS = [
  {
    title: 'Log in',
    value: AuthTab.LOGIN,
  },
  {
    title: 'Sign up',
    value: AuthTab.SIGNUP,
  },
]

export function AuthPage() {
  const [currentTab, setCurrentTab] = useState<AuthTab>(AuthTab.LOGIN)
  const [indicatorStyle, setIndicatorStyle] = useState({
    width: 0,
    x: 0,
  })
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([])

  // Set once an account is created, to prefill and greet on the log in tab.
  const [signedUpEmail, setSignedUpEmail] = useState<string | null>(null)

  function handleCreated(email: string) {
    setSignedUpEmail(email)
    setCurrentTab(AuthTab.LOGIN)
  }

  const FORM_COMPONENT = new Map([
    [
      AuthTab.LOGIN,
      <LoginForm
        defaultEmail={signedUpEmail ?? ''}
        notice={
          signedUpEmail ? 'Account created — log in to continue.' : undefined
        }
      />,
    ],
    [AuthTab.SIGNUP, <SignupForm onCreated={handleCreated} />],
  ])

  useEffect(() => {
    const activeIndex = TABS.findIndex((tab) => tab.value === currentTab)
    const el = tabsRef.current[activeIndex]

    if (el) {
      setIndicatorStyle({
        width: el.offsetWidth,
        x: el.offsetLeft,
      })
    }
  }, [currentTab])

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Ambient brand glow behind the card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-30 -left-25 size-105 rounded-full opacity-35 blur-[20px]"
        style={{
          background:
            'radial-gradient(circle, var(--color-brand-500), transparent 70%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-35 -right-30 size-120 rounded-full opacity-20 blur-[20px]"
        style={{
          background:
            'radial-gradient(circle, var(--color-success-500), transparent 70%)',
        }}
      />

      <div className="relative bg-gray-800 mx-auto max-w-xl my-24 border border-white-08 rounded-xl p-10">
        <Logo size="md" className="mb-8" />

        <div className="flex p-0.5 rounded-lg relative">
          {TABS.map((tab, index) => {
            const isActive = currentTab === tab.value

            return (
              <Tab
                ref={(el) => {
                  tabsRef.current[index] = el
                }}
                className="w-90"
                active={isActive}
                value={tab.value}
                title={tab.title}
                onClick={() => setCurrentTab(tab.value)}
                key={tab.value}
              />
            )
          })}

          <div
            className="absolute top-0 left-0 h-full rounded-[9px] bg-brand-500 transition-all duration-300"
            style={{
              width: indicatorStyle.width,
              transform: `translateX(${indicatorStyle.x}px)`,
            }}
          />
        </div>

        {FORM_COMPONENT.get(currentTab)}
      </div>
    </div>
  )
}
