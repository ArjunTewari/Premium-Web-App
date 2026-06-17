import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Login from "@/pages/login";
import Signup from "@/pages/signup";
import Admin from "@/pages/admin";
import { AuthProvider, useAuth } from "@/lib/auth";

const queryClient = new QueryClient();

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullScreenLoader />;
  if (!user) return <Redirect to="/login" />;
  return <Component />;
}

function PublicOnlyRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullScreenLoader />;
  if (user) return <Redirect to="/" />;
  return <Component />;
}

function FullScreenLoader() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0e17",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#64748b",
      fontFamily: "'Inter', sans-serif",
      fontSize: 14,
    }}>
      Loading…
    </div>
  );
}

function AppRoutes() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return (
    <WouterRouter base={base}>
      <Switch>
        <Route path="/login">
          <PublicOnlyRoute component={Login} />
        </Route>
        <Route path="/signup">
          <PublicOnlyRoute component={Signup} />
        </Route>
        <Route path="/admin">
          <ProtectedRoute component={Admin} />
        </Route>
        <Route path="/">
          <ProtectedRoute component={Home} />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </WouterRouter>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
